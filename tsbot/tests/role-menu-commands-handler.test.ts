import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { handleRoleMenuCommand } from "../src/discord/role-menu-commands-handler.js";
import { createRoleMenuCustomId } from "../src/discord/role-menu-components.js";
import type { GuildRuntime } from "../src/runtime.js";

const GUILD_ID = "111111111111111111";
const ACTOR_ID = "222222222222222222";
const MEMBER_ID = "333333333333333333";
const BOT_ID = "444444444444444444";
const CHANNEL_ID = "555555555555555555";
const ROLE_ONE = "666666666666666666";
const ROLE_TWO = "777777777777777777";
const ROLE_THREE = "888888888888888888";
const MENU_ID = "menuAlpha001";
const NOW = "2026-08-23T00:00:00.000Z";

function createHarness(input: {
  subcommand: "create" | "edit" | "status" | "recover";
  posts?: Array<Record<string, any>>;
  selectedMember?: boolean;
  strings?: Readonly<Record<string, string>>;
  integers?: Readonly<Record<string, number>>;
}) {
  const guild: Record<string, any> = {
    id: GUILD_ID,
    ownerId: ACTOR_ID,
  };
  const role = (id: string, name: string) => ({
    id,
    name,
    guild,
    managed: false,
    permissions: { bitfield: 0n },
  });
  const roles = new Map<string, Record<string, any>>([
    [ROLE_ONE, role(ROLE_ONE, "Gold")],
    [ROLE_TWO, role(ROLE_TWO, "Silver")],
    [ROLE_THREE, role(ROLE_THREE, "Bronze")],
  ]);
  const actor: Record<string, any> = {
    id: ACTOR_ID,
    guild,
    user: { id: ACTOR_ID, bot: false },
    permissions: { has: vi.fn(() => false) },
    roles: {
      cache: new Collection(),
      highest: { comparePositionTo: vi.fn(() => 1) },
    },
  };
  const memberRoleCache = new Collection<string, Record<string, any>>([
    [ROLE_ONE, roles.get(ROLE_ONE)!],
  ]);
  const member: Record<string, any> = {
    id: MEMBER_ID,
    guild,
    user: { id: MEMBER_ID, bot: false },
    permissions: { has: vi.fn(() => false) },
    roles: {
      cache: memberRoleCache,
      add: vi.fn(async (selectedRole: Record<string, any>) => {
        memberRoleCache.set(selectedRole.id, selectedRole);
        return member;
      }),
      remove: vi.fn(async (selectedRole: Record<string, any>) => {
        memberRoleCache.delete(selectedRole.id);
        return member;
      }),
    },
  };
  const botMember: Record<string, any> = {
    id: BOT_ID,
    guild,
    user: { id: BOT_ID, bot: true },
    permissions: {
      has: vi.fn(
        (permission: bigint) => permission === PermissionFlagsBits.ManageRoles,
      ),
    },
    roles: {
      cache: new Collection(),
      highest: { comparePositionTo: vi.fn(() => 1) },
    },
  };
  guild.members = {
    fetch: vi.fn(async (request: { user: string } | string) => {
      const userId = typeof request === "string" ? request : request.user;
      if (userId === ACTOR_ID) return actor;
      if (userId === MEMBER_ID) return member;
      return null;
    }),
    fetchMe: vi.fn(async () => botMember),
  };
  guild.roles = {
    fetch: vi.fn(async (roleId: string) => roles.get(roleId) ?? null),
  };

  const menu: Record<string, any> = {
    guildId: GUILD_ID,
    menuId: MENU_ID,
    slug: "member-colors",
    title: "Member colors",
    description: "Choose the roles you want to keep.",
    sortOrder: 3,
    state: "enabled",
    mode: "toggle",
    minSelections: 0,
    maxSelections: 3,
    requiredRoleId: null,
    definitionVersion: 4,
    bindingsVerifiedAt: NOW,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const menuOptions = [
    menuOption("optionAlpha01", ROLE_ONE, "Gold", 0),
    menuOption("optionAlpha02", ROLE_TWO, "Silver", 1),
    menuOption("optionAlpha03", ROLE_THREE, "Bronze", 2),
  ];
  const posts = input.posts ?? [];
  const missingMessages = new Set<string>();
  const staleMessages = new Set<string>();
  const fetchMessage = vi.fn(async (messageId: string) => {
    if (missingMessages.has(messageId)) return null;
    const post = posts.find((candidate) => candidate.messageId === messageId);
    if (!post) return null;
    const customId = staleMessages.has(messageId)
      ? "superior:rolemenu:stale"
      : createRoleMenuCustomId(
          menu.menuId,
          post.postId,
          menu.definitionVersion,
        );
    return {
      id: messageId,
      channelId: post.channelId,
      guildId: GUILD_ID,
      author: { id: BOT_ID, bot: true },
      components: [{ components: [{ customId }] }],
    };
  });
  const channel: Record<string, any> = {
    id: CHANNEL_ID,
    guild,
    type: ChannelType.GuildText,
    messages: { fetch: fetchMessage },
  };
  guild.channels = {
    fetch: vi.fn(async (channelId: string) =>
      channelId === CHANNEL_ID ? channel : null,
    ),
  };

  const listRoleMenuOperations = vi.fn((): Array<Record<string, any>> => []);
  const repository = {
    getRoleMenuBySlug: vi.fn(() => menu),
    createRoleMenu: vi.fn((createInput: Record<string, any>) => ({
      ...menu,
      slug: createInput.slug,
      title: createInput.title,
      description: createInput.description,
      sortOrder: createInput.sortOrder ?? 0,
      state: "disabled",
      mode: createInput.mode,
      minSelections: createInput.minSelections,
      maxSelections: createInput.maxSelections,
      requiredRoleId: createInput.requiredRoleId,
      definitionVersion: 1,
      bindingsVerifiedAt: null,
    })),
    updateRoleMenu: vi.fn(
      (_menuId: string, updateInput: Record<string, any>) => ({
        ...menu,
        ...(updateInput.sortOrder === undefined
          ? {}
          : { sortOrder: updateInput.sortOrder }),
      }),
    ),
    listRoleMenuOptions: vi.fn(() => menuOptions),
    listRoleMenuPosts: vi.fn(() => posts),
    listRoleMenuOperations,
    listCapabilitiesForRoles: vi.fn(() => []),
    setRoleMenuPostState: vi.fn(
      (postId: string, state: "stale" | "missing") => ({
        ...posts.find((post) => post.postId === postId),
        state,
      }),
    ),
    reserveRoleMenuOperation: vi.fn(() => ({
      status: "reserved" as const,
      operation: { operationId: "recoveryOperation01", state: "reserved" },
    })),
    completeRoleMenuOperation: vi.fn(),
    recordCommandMetric: vi.fn(),
  };
  const runtime = {
    guildId: GUILD_ID,
    storage: repository,
    isCurrent: vi.fn(() => true),
  } as unknown as GuildRuntime;
  const interaction: Record<string, any> = {
    id: "999999999999999999",
    guild,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    user: { id: ACTOR_ID },
    client: { user: { id: BOT_ID } },
    options: {
      getSubcommandGroup: vi.fn(() => null),
      getSubcommand: vi.fn(() => input.subcommand),
      getString: vi.fn(
        (name: string) =>
          input.strings?.[name] ?? (name === "slug" ? menu.slug : null),
      ),
      getInteger: vi.fn((name: string) => input.integers?.[name] ?? null),
      getBoolean: vi.fn(() => null),
      getRole: vi.fn(() => null),
      getUser: vi.fn((name: string) =>
        name === "member" && input.selectedMember
          ? { id: MEMBER_ID, bot: false }
          : null,
      ),
      getChannel: vi.fn(() => null),
    },
    deferred: false,
    replied: false,
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };

  return {
    actor,
    member,
    menu,
    posts,
    repository,
    runtime,
    interaction,
    fetchMessage,
    missingMessages,
    staleMessages,
    listRoleMenuOperations,
  };
}

function menuOption(
  optionId: string,
  roleId: string,
  label: string,
  sortOrder: number,
): Record<string, any> {
  return {
    guildId: GUILD_ID,
    menuId: MENU_ID,
    optionId,
    roleId,
    label,
    description: null,
    emoji: null,
    sortOrder,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function roleMenuPost(index: number): Record<string, any> {
  return {
    guildId: GUILD_ID,
    postId: `post${String(index).padStart(8, "0")}`,
    menuId: MENU_ID,
    channelId: CHANNEL_ID,
    messageId: `6${String(index).padStart(17, "0")}`,
    definitionVersion: 4,
    bindingsVerifiedAt: NOW,
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function operation(
  operationId: string,
  state: "completed" | "partial" | "failed",
  items: Array<Record<string, any>>,
): Record<string, any> {
  return {
    guildId: GUILD_ID,
    operationId,
    interactionId: "900000000000000001",
    menuId: MENU_ID,
    memberId: MEMBER_ID,
    definitionVersion: 4,
    selectionKey: "optionAlpha02",
    state,
    failureCode: state === "completed" ? null : "discord-access",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    items,
  };
}

function latestContent(interaction: Record<string, any>): string {
  for (const mock of [
    interaction.followUp,
    interaction.editReply,
    interaction.reply,
  ]) {
    const payload = mock.mock.calls.at(-1)?.[0];
    if (payload && typeof payload.content === "string") return payload.content;
  }
  return "";
}

async function run(harness: ReturnType<typeof createHarness>): Promise<void> {
  await handleRoleMenuCommand(
    harness.interaction as never,
    harness.runtime,
    harness.actor as never,
  );
}

describe("role-menu ordering command surface", () => {
  it("maps a one-based create position to zero-based storage order", async () => {
    const harness = createHarness({
      subcommand: "create",
      strings: {
        slug: "ordered-menu",
        title: "Ordered menu",
        description: "A deliberately ordered menu.",
        mode: "toggle",
      },
      integers: { position: 3 },
    });

    await run(harness);

    expect(harness.repository.createRoleMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "ordered-menu",
        sortOrder: 2,
        actorId: ACTOR_ID,
      }),
    );
    expect(latestContent(harness.interaction)).toContain("at position 3");
  });

  it("maps an order-only edit without implying definition staleness", async () => {
    const harness = createHarness({
      subcommand: "edit",
      integers: { position: 2 },
    });

    await run(harness);

    expect(harness.repository.updateRoleMenu).toHaveBeenCalledWith(MENU_ID, {
      actorId: ACTOR_ID,
      expectedDefinitionVersion: 4,
      sortOrder: 1,
    });
    expect(latestContent(harness.interaction)).toContain(
      "Moved `member-colors` to position 2",
    );
    expect(latestContent(harness.interaction)).toContain(
      "definition remains 4",
    );
    expect(latestContent(harness.interaction)).not.toMatch(/disable|stale/iu);
    expect(harness.repository.setRoleMenuPostState).not.toHaveBeenCalled();
  });
});

describe("role-menu command recovery review fixes", () => {
  it("live-checks active messages and bound controls for status", async () => {
    const posts = [roleMenuPost(1), roleMenuPost(2), roleMenuPost(3)];
    const harness = createHarness({ subcommand: "status", posts });
    harness.staleMessages.add(posts[1]!.messageId);
    harness.missingMessages.add(posts[2]!.messageId);

    await run(harness);

    expect(harness.fetchMessage).toHaveBeenCalledTimes(3);
    expect(latestContent(harness.interaction)).toContain(
      "Post bindings: 1 live, 1 stale, 1 missing (3 active checked)",
    );
    expect(latestContent(harness.interaction)).toContain("Position: **4**");
    expect(harness.repository.recordCommandMetric).toHaveBeenCalledWith(
      "rolemenu.status",
      false,
    );
  });

  it("checks and repairs active bindings after the first 25 records", async () => {
    const posts = Array.from({ length: 30 }, (_, index) =>
      roleMenuPost(index + 1),
    );
    const harness = createHarness({ subcommand: "recover", posts });
    harness.missingMessages.add(posts[29]!.messageId);

    await run(harness);

    expect(harness.fetchMessage).toHaveBeenCalledTimes(30);
    expect(harness.repository.setRoleMenuPostState).toHaveBeenCalledWith(
      posts[29]!.postId,
      "missing",
      null,
    );
    expect(latestContent(harness.interaction)).toContain(
      "29 live, 0 newly stale, and 1 newly missing",
    );
  });

  it("does not recover an older failure superseded by a completed selection", async () => {
    const harness = createHarness({
      subcommand: "recover",
      selectedMember: true,
    });
    harness.listRoleMenuOperations.mockReturnValue([
      operation("newCompleted01", "completed", [
        { roleId: ROLE_ONE, action: "remove", state: "completed" },
        { roleId: ROLE_TWO, action: "add", state: "completed" },
      ]),
      operation("oldFailure001", "failed", [
        { roleId: ROLE_ONE, action: "remove", state: "skipped" },
        { roleId: ROLE_TWO, action: "add", state: "failed" },
      ]),
    ]);

    await run(harness);

    expect(latestContent(harness.interaction)).toContain(
      "No unresolved role-menu selection",
    );
    expect(harness.repository.reserveRoleMenuOperation).not.toHaveBeenCalled();
    expect(harness.member.roles.add).not.toHaveBeenCalled();
    expect(harness.member.roles.remove).not.toHaveBeenCalled();
  });

  it("records failed recovery calls separately from unattempted planned work", async () => {
    const harness = createHarness({
      subcommand: "recover",
      selectedMember: true,
    });
    harness.listRoleMenuOperations.mockReturnValue([
      operation("latestFailure01", "failed", [
        { roleId: ROLE_TWO, action: "add", state: "failed" },
        { roleId: ROLE_THREE, action: "add", state: "skipped" },
        { roleId: ROLE_ONE, action: "remove", state: "skipped" },
      ]),
    ]);
    harness.member.roles.add.mockRejectedValueOnce(
      Object.assign(new Error("missing permissions"), { code: 50_013 }),
    );

    await run(harness);

    expect(harness.member.roles.add).toHaveBeenCalledOnce();
    expect(harness.member.roles.remove).not.toHaveBeenCalled();
    expect(harness.repository.completeRoleMenuOperation).toHaveBeenCalledWith(
      "recoveryOperation01",
      {
        state: "failed",
        addedRoleIds: [],
        removedRoleIds: [],
        failedRoleIds: [ROLE_TWO],
        skippedRoleIds: [ROLE_THREE, ROLE_ONE],
        failureCode: "discord-access",
      },
    );
    expect(latestContent(harness.interaction)).toContain(
      "Attempted: 1 · confirmed: 0 · failed: 1 · skipped: 2",
    );
  });
});
