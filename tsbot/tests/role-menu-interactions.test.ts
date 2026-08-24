import { Collection, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  handleRoleMenuSelect,
  roleMenuInteractionQueueSize,
} from "../src/discord/role-menu-interactions.js";
import {
  buildRoleMenuPanelPayload,
  createRoleMenuCustomId,
} from "../src/discord/role-menu-components.js";
import type { GuildRuntime } from "../src/runtime.js";

const GUILD_ID = "111111111111111111";
const OTHER_GUILD_ID = "222222222222222222";
const MEMBER_ID = "333333333333333333";
const BOT_ID = "444444444444444444";
const CHANNEL_ID = "555555555555555555";
const MESSAGE_ID = "666666666666666666";
const SECOND_MESSAGE_ID = "777777777777777777";
const ROLE_ONE = "888888888888888888";
const ROLE_TWO = "999999999999999999";
const ROLE_THREE = "900000000000000001";
const REQUIRED_ROLE = "900000000000000002";
const UNRELATED_ROLE = "900000000000000003";
const MENU_ID = "menuAlpha001";
const POST_ID = "postAlpha001";
const OPTION_ONE = "optionAlpha01";
const OPTION_TWO = "optionAlpha02";
const OPTION_THREE = "optionAlpha03";
const NOW = "2026-08-23T00:00:00.000Z";

function createHarness(
  options: {
    mode?: "toggle" | "exclusive" | "limited";
    minSelections?: number;
    maxSelections?: number;
    values?: string[];
    currentRoleIds?: string[];
    requiredRoleId?: string | null;
    menuOptionCount?: number;
  } = {},
) {
  const guild: Record<string, any> = {
    id: GUILD_ID,
    ownerId: "900000000000000004",
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
    [REQUIRED_ROLE, role(REQUIRED_ROLE, "Member")],
    [UNRELATED_ROLE, role(UNRELATED_ROLE, "Unrelated")],
  ]);
  const bulkDefinitions = Array.from(
    { length: options.menuOptionCount ?? 0 },
    (_, index) => ({
      optionId: `o${String(index).padStart(23, "0")}`,
      roleId: String(910_000_000_000_000_000n + BigInt(index)),
      label: `Role ${index + 1}`,
    }),
  );
  for (const item of bulkDefinitions) {
    roles.set(item.roleId, role(item.roleId, item.label));
  }
  const memberRoleCache = new Collection<string, Record<string, any>>();
  for (const roleId of options.currentRoleIds ?? [ROLE_ONE]) {
    const current = roles.get(roleId);
    if (current) memberRoleCache.set(roleId, current);
  }
  const member: Record<string, any> = {
    id: MEMBER_ID,
    guild,
    user: { id: MEMBER_ID, bot: false },
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
      highest: { comparePositionTo: vi.fn(() => 1) },
      cache: new Collection(),
    },
  };
  guild.members = {
    fetch: vi.fn(async () => member),
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
    state: "enabled",
    mode: options.mode ?? "toggle",
    minSelections: options.minSelections ?? 0,
    maxSelections: options.maxSelections ?? 2,
    requiredRoleId: options.requiredRoleId ?? null,
    definitionVersion: 4,
    bindingsVerifiedAt: NOW,
    createdBy: BOT_ID,
    updatedBy: BOT_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const menuOptions: Array<Record<string, any>> = bulkDefinitions.length
    ? bulkDefinitions.map((item, index) => ({
        guildId: GUILD_ID,
        menuId: MENU_ID,
        optionId: item.optionId,
        roleId: item.roleId,
        label: item.label,
        description: null,
        emoji: null,
        sortOrder: index,
        createdAt: NOW,
        updatedAt: NOW,
      }))
    : [
        {
          guildId: GUILD_ID,
          menuId: MENU_ID,
          optionId: OPTION_ONE,
          roleId: ROLE_ONE,
          label: "Gold",
          description: null,
          emoji: null,
          sortOrder: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          guildId: GUILD_ID,
          menuId: MENU_ID,
          optionId: OPTION_TWO,
          roleId: ROLE_TWO,
          label: "Silver",
          description: null,
          emoji: null,
          sortOrder: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ];
  const post: Record<string, any> = {
    guildId: GUILD_ID,
    postId: POST_ID,
    menuId: MENU_ID,
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    definitionVersion: menu.definitionVersion,
    bindingsVerifiedAt: NOW,
    state: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  let operationNumber = 0;
  const repository = {
    getRoleMenuById: vi.fn((menuId: string) =>
      menuId === menu.menuId ? menu : null,
    ),
    getRoleMenuPostById: vi.fn((postId: string) =>
      postId === post.postId ? post : null,
    ),
    findRoleMenuPostByMessage: vi.fn((channelId: string, messageId: string) =>
      channelId === post.channelId && messageId === post.messageId
        ? post
        : null,
    ),
    listRoleMenuOptions: vi.fn(() => menuOptions),
    reserveRoleMenuOperation: vi.fn((_input: Record<string, unknown>) => ({
      status: "reserved" as const,
      operation: {
        operationId: `operation${String(++operationNumber).padStart(3, "0")}`,
        state: "pending" as const,
      },
    })),
    completeRoleMenuOperation: vi.fn(
      (_operationId: string, input: { state: string }) => ({
        operationId: _operationId,
        state: input.state,
      }),
    ),
    recordCommandMetric: vi.fn(),
  };
  const isCurrent = vi.fn(() => true);
  const runtime = {
    guildId: GUILD_ID,
    storage: repository,
    isCurrent,
  } as unknown as GuildRuntime;

  function makeInteraction(
    input: {
      id?: string;
      values?: string[];
      customId?: string;
      guildId?: string | null;
      channelId?: string;
      messageId?: string;
      messageAuthorId?: string;
    } = {},
  ) {
    const interaction: Record<string, any> = {
      id: input.id ?? "900000000000000010",
      customId:
        input.customId ??
        createRoleMenuCustomId(
          menu.menuId,
          post.postId,
          menu.definitionVersion,
        ),
      values: input.values ?? options.values ?? [OPTION_TWO],
      guild,
      guildId: input.guildId === undefined ? GUILD_ID : input.guildId,
      channelId: input.channelId ?? CHANNEL_ID,
      user: { id: MEMBER_ID },
      client: { user: { id: BOT_ID } },
      message: {
        id: input.messageId ?? MESSAGE_ID,
        channelId: input.channelId ?? CHANNEL_ID,
        guildId: input.guildId === undefined ? GUILD_ID : input.guildId,
        author: { id: input.messageAuthorId ?? BOT_ID, bot: true },
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    interaction.deferReply = vi.fn(async () => {
      interaction.deferred = true;
    });
    return interaction;
  }

  const interaction = makeInteraction();
  return {
    guild,
    roles,
    member,
    botMember,
    menu,
    menuOptions,
    post,
    repository,
    runtime,
    isCurrent,
    interaction,
    makeInteraction,
  };
}

function addThirdOption(harness: ReturnType<typeof createHarness>): void {
  harness.menuOptions.push({
    guildId: GUILD_ID,
    menuId: MENU_ID,
    optionId: OPTION_THREE,
    roleId: ROLE_THREE,
    label: "Bronze",
    description: null,
    emoji: null,
    sortOrder: 2,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function latestContent(interaction: Record<string, any>): string {
  for (const mock of [
    interaction.followUp,
    interaction.editReply,
    interaction.reply,
  ]) {
    const call = mock.mock.calls.at(-1);
    if (call?.[0] && typeof call[0].content === "string") {
      return call[0].content;
    }
  }
  return "";
}

async function select(
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  await expect(
    handleRoleMenuSelect(harness.interaction as never, harness.runtime),
  ).resolves.toBe(true);
}

describe("persistent role-menu interactions", () => {
  it("renders one bounded mention-suppressed select menu", () => {
    const harness = createHarness();
    const payload = buildRoleMenuPanelPayload(
      harness.menu as never,
      harness.menuOptions as never,
      POST_ID,
    );

    expect(payload.components).toHaveLength(1);
    expect(payload.allowedMentions.parse).toEqual([]);
    expect(
      payload.components[0]!.toJSON().components[0]!.custom_id.length,
    ).toBeLessThanOrEqual(100);
  });

  it("rejects a title that exceeds Discord limits after safe escaping", () => {
    const harness = createHarness();
    harness.menu.title = "*".repeat(160);

    expect(() =>
      buildRoleMenuPanelPayload(
        harness.menu as never,
        harness.menuOptions as never,
        POST_ID,
      ),
    ).toThrow(/after safe Markdown escaping/u);
  });

  it("builds a toggle plan from the member's complete desired set", async () => {
    const harness = createHarness({ values: [OPTION_ONE, OPTION_TWO] });

    await select(harness);

    expect(harness.repository.reserveRoleMenuOperation).toHaveBeenCalledWith({
      interactionId: harness.interaction.id,
      menuId: MENU_ID,
      memberId: MEMBER_ID,
      definitionVersion: 4,
      selectionKey: `${OPTION_ONE},${OPTION_TWO}`,
      plannedAdds: [ROLE_TWO],
      plannedRemovals: [],
    });
    expect(harness.member.roles.add).toHaveBeenCalledWith(
      harness.roles.get(ROLE_TWO),
      `Superior role menu ${MENU_ID}`,
    );
    expect(harness.member.roles.remove).not.toHaveBeenCalled();
    expect(harness.repository.completeRoleMenuOperation).toHaveBeenCalledWith(
      "operation001",
      {
        state: "completed",
        addedRoleIds: [ROLE_TWO],
        removedRoleIds: [],
        failedRoleIds: [],
        skippedRoleIds: [],
        failureCode: null,
      },
    );
    expect(latestContent(harness.interaction)).toContain(
      "selection was applied",
    );
  });

  it("persists a maximum 25-option selection with maximum-length opaque IDs", async () => {
    const values = Array.from(
      { length: 25 },
      (_, index) => `o${String(index).padStart(23, "0")}`,
    );
    const harness = createHarness({
      menuOptionCount: 25,
      maxSelections: 25,
      currentRoleIds: [],
      values,
    });

    await select(harness);

    const selectionKey = values.join(",");
    expect(selectionKey).toHaveLength(624);
    expect(harness.repository.reserveRoleMenuOperation).toHaveBeenCalledWith(
      expect.objectContaining({ selectionKey }),
    );
    expect(harness.member.roles.add).toHaveBeenCalledTimes(25);
    expect(latestContent(harness.interaction)).toContain(
      "selection was applied",
    );
  });

  it("adds the exclusive replacement before removing the prior menu role", async () => {
    const harness = createHarness({
      mode: "exclusive",
      maxSelections: 1,
      values: [OPTION_TWO],
    });

    await select(harness);

    expect(harness.repository.reserveRoleMenuOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        plannedAdds: [ROLE_TWO],
        plannedRemovals: [ROLE_ONE],
      }),
    );
    expect(harness.member.roles.add).toHaveBeenCalledOnce();
    expect(harness.member.roles.remove).toHaveBeenCalledOnce();
    expect(harness.member.roles.add.mock.invocationCallOrder[0]).toBeLessThan(
      harness.member.roles.remove.mock.invocationCallOrder[0]!,
    );
    expect(harness.member.roles.cache.has(ROLE_TWO)).toBe(true);
    expect(harness.member.roles.cache.has(ROLE_ONE)).toBe(false);
  });

  it("applies a limited multi-add plan before removing deselected roles", async () => {
    const harness = createHarness({
      mode: "limited",
      minSelections: 1,
      maxSelections: 2,
      values: [OPTION_TWO, OPTION_THREE],
    });
    addThirdOption(harness);

    await select(harness);

    expect(harness.repository.reserveRoleMenuOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionKey: `${OPTION_TWO},${OPTION_THREE}`,
        plannedAdds: [ROLE_TWO, ROLE_THREE],
        plannedRemovals: [ROLE_ONE],
      }),
    );
    expect(
      harness.member.roles.add.mock.calls.map(
        (call: Array<{ id: string }>) => call[0]!.id,
      ),
    ).toEqual([ROLE_TWO, ROLE_THREE]);
    expect(harness.member.roles.add.mock.invocationCallOrder[1]).toBeLessThan(
      harness.member.roles.remove.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    {
      name: "below the minimum",
      mode: "limited" as const,
      min: 1,
      max: 2,
      values: [] as string[],
      message: "Choose between 1 and 2 roles",
    },
    {
      name: "above the maximum",
      mode: "limited" as const,
      min: 0,
      max: 1,
      values: [OPTION_ONE, OPTION_TWO],
      message: "Choose between 0 and 1 roles",
    },
    {
      name: "multiple exclusive choices",
      mode: "exclusive" as const,
      min: 0,
      max: 1,
      values: [OPTION_ONE, OPTION_TWO],
      message: "at most one selected role",
    },
  ])(
    "rejects a selection $name",
    async ({ mode, min, max, values, message }) => {
      const harness = createHarness({
        mode,
        minSelections: min,
        maxSelections: max,
        values,
      });

      await select(harness);

      expect(latestContent(harness.interaction)).toContain(message);
      expect(harness.guild.members.fetch).not.toHaveBeenCalled();
      expect(
        harness.repository.reserveRoleMenuOperation,
      ).not.toHaveBeenCalled();
    },
  );

  it("requires a fresh prerequisite role held by the selecting member", async () => {
    const harness = createHarness({ requiredRoleId: REQUIRED_ROLE });

    await select(harness);

    expect(harness.guild.roles.fetch).toHaveBeenCalledWith(REQUIRED_ROLE, {
      cache: true,
      force: true,
    });
    expect(latestContent(harness.interaction)).toContain("You need **Member**");
    expect(harness.repository.reserveRoleMenuOperation).not.toHaveBeenCalled();
    expect(harness.member.roles.add).not.toHaveBeenCalled();
  });

  it("allows a member who holds the freshly verified prerequisite", async () => {
    const harness = createHarness({
      requiredRoleId: REQUIRED_ROLE,
      currentRoleIds: [ROLE_ONE, REQUIRED_ROLE],
    });

    await select(harness);

    expect(harness.repository.reserveRoleMenuOperation).toHaveBeenCalledOnce();
    expect(harness.member.roles.add).toHaveBeenCalledWith(
      harness.roles.get(ROLE_TWO),
      expect.any(String),
    );
  });

  it("fails safely when the prerequisite role was deleted", async () => {
    const harness = createHarness({ requiredRoleId: REQUIRED_ROLE });
    harness.roles.delete(REQUIRED_ROLE);

    await select(harness);

    expect(latestContent(harness.interaction)).toContain(
      "prerequisite role was deleted",
    );
    expect(harness.repository.reserveRoleMenuOperation).not.toHaveBeenCalled();
  });

  it("ignores unrelated component IDs and safely handles malformed role-menu IDs", async () => {
    const unrelated = createHarness();
    unrelated.interaction.customId = "superior:another-component";
    await expect(
      handleRoleMenuSelect(unrelated.interaction as never, unrelated.runtime),
    ).resolves.toBe(false);
    expect(unrelated.interaction.deferReply).not.toHaveBeenCalled();

    const malformed = createHarness();
    malformed.interaction.customId = "superior:rolemenu:copied";
    await select(malformed);
    expect(latestContent(malformed.interaction)).toContain(
      "disabled, outdated, copied",
    );
    expect(malformed.interaction.deferReply).not.toHaveBeenCalled();
  });

  it.each([
    ["stale version", "version"],
    ["copied post token", "post"],
    ["copied message binding", "message"],
    ["cross-guild interaction", "interaction-guild"],
    ["cross-guild stored menu", "menu-guild"],
  ] as const)("rejects a %s", async (_name, mutation) => {
    const harness = createHarness();
    if (mutation === "version") {
      harness.interaction.customId = createRoleMenuCustomId(
        MENU_ID,
        POST_ID,
        harness.menu.definitionVersion + 1,
      );
    } else if (mutation === "post") {
      harness.interaction.customId = createRoleMenuCustomId(
        MENU_ID,
        "copiedPost01",
        harness.menu.definitionVersion,
      );
    } else if (mutation === "message") {
      harness.interaction.message.id = SECOND_MESSAGE_ID;
    } else if (mutation === "interaction-guild") {
      harness.interaction.guildId = OTHER_GUILD_ID;
      harness.interaction.message.guildId = OTHER_GUILD_ID;
    } else {
      harness.menu.guildId = OTHER_GUILD_ID;
    }

    await select(harness);

    expect(latestContent(harness.interaction)).toContain(
      "disabled, outdated, copied",
    );
    expect(harness.guild.members.fetch).not.toHaveBeenCalled();
    expect(harness.repository.reserveRoleMenuOperation).not.toHaveBeenCalled();
  });

  it.each(["disabled", "archived"] as const)(
    "rejects a %s menu without touching member roles",
    async (state) => {
      const harness = createHarness();
      harness.menu.state = state;
      harness.menu.bindingsVerifiedAt = null;

      await select(harness);

      expect(latestContent(harness.interaction)).toContain(
        "disabled, outdated, copied",
      );
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(
        harness.repository.reserveRoleMenuOperation,
      ).not.toHaveBeenCalled();
    },
  );

  it("rejects a deleted option role before reserving a mutation", async () => {
    const harness = createHarness();
    harness.roles.delete(ROLE_TWO);

    await select(harness);

    expect(latestContent(harness.interaction)).toContain(
      "role in this menu was deleted",
    );
    expect(harness.repository.reserveRoleMenuOperation).not.toHaveBeenCalled();
    expect(harness.member.roles.add).not.toHaveBeenCalled();
  });

  it("rejects an option role with dangerous permissions", async () => {
    const harness = createHarness();
    harness.roles.get(ROLE_TWO)!.permissions.bitfield =
      PermissionFlagsBits.Administrator;

    await select(harness);

    expect(latestContent(harness.interaction)).toContain(
      "dangerous server-management permissions",
    );
    expect(harness.repository.reserveRoleMenuOperation).not.toHaveBeenCalled();
    expect(harness.member.roles.add).not.toHaveBeenCalled();
  });

  it("rejects duplicated option IDs in a selection payload", async () => {
    const harness = createHarness({ values: [OPTION_TWO, OPTION_TWO] });

    await select(harness);

    expect(latestContent(harness.interaction)).toContain(
      "selection payload is invalid",
    );
    expect(harness.guild.members.fetch).not.toHaveBeenCalled();
    expect(harness.repository.reserveRoleMenuOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", "confirmed roles were not changed again"],
    ["partial", "already recorded with incomplete work"],
  ] as const)(
    "does not replay a duplicate %s operation",
    async (state, message) => {
      const harness = createHarness();
      harness.repository.reserveRoleMenuOperation.mockReturnValueOnce({
        status: "duplicate" as never,
        operation: { operationId: "operation001", state } as never,
      });

      await select(harness);

      expect(latestContent(harness.interaction)).toContain(message);
      expect(harness.member.roles.add).not.toHaveBeenCalled();
      expect(harness.member.roles.remove).not.toHaveBeenCalled();
      expect(
        harness.repository.completeRoleMenuOperation,
      ).not.toHaveBeenCalled();
    },
  );

  it("preserves every prior menu role when an addition fails", async () => {
    const harness = createHarness();
    harness.member.roles.add.mockRejectedValueOnce(
      Object.assign(new Error("missing permissions"), { code: 50_013 }),
    );

    await select(harness);

    expect(harness.member.roles.remove).not.toHaveBeenCalled();
    expect(harness.member.roles.cache.has(ROLE_ONE)).toBe(true);
    expect(harness.member.roles.cache.has(ROLE_TWO)).toBe(false);
    expect(harness.repository.completeRoleMenuOperation).toHaveBeenCalledWith(
      "operation001",
      {
        state: "failed",
        addedRoleIds: [],
        removedRoleIds: [],
        failedRoleIds: [ROLE_TWO],
        skippedRoleIds: [ROLE_ONE],
        failureCode: "discord-access",
      },
    );
    expect(latestContent(harness.interaction)).toContain(
      "prior menu roles were preserved",
    );
    expect(latestContent(harness.interaction)).toContain(
      "Attempted: 1 · confirmed: 0 · failed: 1 · skipped: 1",
    );
  });

  it("marks later additions and protected removals as skipped after an add failure", async () => {
    const harness = createHarness({
      values: [OPTION_TWO, OPTION_THREE],
    });
    addThirdOption(harness);
    harness.member.roles.add.mockRejectedValueOnce(
      Object.assign(new Error("missing permissions"), { code: 50_013 }),
    );

    await select(harness);

    expect(harness.member.roles.add).toHaveBeenCalledOnce();
    expect(harness.member.roles.remove).not.toHaveBeenCalled();
    expect(harness.repository.completeRoleMenuOperation).toHaveBeenCalledWith(
      "operation001",
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

  it.each(["disabled", "archived"] as const)(
    "stops every remaining mutation when the menu is %s after an addition",
    async (state) => {
      const harness = createHarness({
        values: [OPTION_TWO, OPTION_THREE],
      });
      addThirdOption(harness);
      harness.member.roles.add.mockImplementationOnce(
        async (selectedRole: Record<string, any>) => {
          harness.member.roles.cache.set(selectedRole.id, selectedRole);
          harness.menu.state = state;
          harness.menu.bindingsVerifiedAt = null;
          harness.menu.updatedAt = "2026-08-23T00:00:01.000Z";
          return harness.member;
        },
      );

      await select(harness);

      expect(
        harness.member.roles.add.mock.calls.map(
          (call: Array<{ id: string }>) => call[0]!.id,
        ),
      ).toEqual([ROLE_TWO]);
      expect(harness.member.roles.remove).not.toHaveBeenCalled();
      expect(harness.member.roles.cache.has(ROLE_ONE)).toBe(true);
      expect(harness.member.roles.cache.has(ROLE_THREE)).toBe(false);
      expect(harness.repository.completeRoleMenuOperation).toHaveBeenCalledWith(
        "operation001",
        {
          state: "partial",
          addedRoleIds: [ROLE_TWO],
          removedRoleIds: [],
          failedRoleIds: [],
          skippedRoleIds: [ROLE_THREE, ROLE_ONE],
          failureCode: "menu-changed",
        },
      );
    },
  );

  it("does not remove a prior role after the reserved menu definition is edited", async () => {
    const harness = createHarness();
    harness.member.roles.add.mockImplementationOnce(
      async (selectedRole: Record<string, any>) => {
        harness.member.roles.cache.set(selectedRole.id, selectedRole);
        harness.menu.title = "Edited member colors";
        harness.menu.definitionVersion += 1;
        harness.menu.updatedAt = "2026-08-23T00:00:01.000Z";
        return harness.member;
      },
    );

    await select(harness);

    expect(harness.member.roles.add).toHaveBeenCalledOnce();
    expect(harness.member.roles.remove).not.toHaveBeenCalled();
    expect(harness.member.roles.cache.has(ROLE_ONE)).toBe(true);
    expect(harness.repository.completeRoleMenuOperation).toHaveBeenCalledWith(
      "operation001",
      {
        state: "partial",
        addedRoleIds: [ROLE_TWO],
        removedRoleIds: [],
        failedRoleIds: [],
        skippedRoleIds: [ROLE_ONE],
        failureCode: "menu-changed",
      },
    );
  });

  it("records a partial outcome when addition succeeds but removal fails", async () => {
    const harness = createHarness();
    harness.member.roles.remove.mockRejectedValueOnce(
      Object.assign(new Error("missing permissions"), { code: 50_013 }),
    );

    await select(harness);

    expect(harness.member.roles.cache.has(ROLE_TWO)).toBe(true);
    expect(harness.member.roles.cache.has(ROLE_ONE)).toBe(true);
    expect(harness.repository.completeRoleMenuOperation).toHaveBeenCalledWith(
      "operation001",
      {
        state: "partial",
        addedRoleIds: [ROLE_TWO],
        removedRoleIds: [],
        failedRoleIds: [ROLE_ONE],
        skippedRoleIds: [],
        failureCode: "discord-access",
      },
    );
    expect(harness.repository.recordCommandMetric).toHaveBeenCalledWith(
      "rolemenu.select",
      false,
    );
    expect(latestContent(harness.interaction)).toContain(
      "only part of the requested role changes",
    );
  });

  it("never removes a role that is unrelated to the menu", async () => {
    const harness = createHarness({
      currentRoleIds: [ROLE_ONE, UNRELATED_ROLE],
    });

    await select(harness);

    expect(
      harness.member.roles.remove.mock.calls.map(
        (call: Array<{ id: string }>) => call[0]!.id,
      ),
    ).toEqual([ROLE_ONE]);
    expect(harness.member.roles.cache.has(UNRELATED_ROLE)).toBe(true);
    expect(harness.repository.reserveRoleMenuOperation).toHaveBeenCalledWith(
      expect.objectContaining({ plannedRemovals: [ROLE_ONE] }),
    );
  });

  it("records an already-current selection as a no-change operation", async () => {
    const harness = createHarness({ values: [OPTION_ONE] });

    await select(harness);

    expect(harness.repository.completeRoleMenuOperation).toHaveBeenCalledWith(
      "operation001",
      {
        state: "no-change",
        addedRoleIds: [],
        removedRoleIds: [],
        failedRoleIds: [],
        skippedRoleIds: [],
      },
    );
    expect(harness.member.roles.add).not.toHaveBeenCalled();
    expect(harness.member.roles.remove).not.toHaveBeenCalled();
    expect(latestContent(harness.interaction)).toContain("already current");
  });

  it("serializes concurrent selections for the same member and menu", async () => {
    const harness = createHarness();
    let releaseAddition!: () => void;
    const additionGate = new Promise<void>((resolve) => {
      releaseAddition = resolve;
    });
    harness.member.roles.add.mockImplementationOnce(
      async (selectedRole: Record<string, any>) => {
        await additionGate;
        harness.member.roles.cache.set(selectedRole.id, selectedRole);
        return harness.member;
      },
    );
    const secondInteraction = harness.makeInteraction({
      id: "900000000000000011",
      values: [OPTION_TWO],
    });

    const first = handleRoleMenuSelect(
      harness.interaction as never,
      harness.runtime,
    );
    await vi.waitFor(() =>
      expect(harness.member.roles.add).toHaveBeenCalledOnce(),
    );
    const second = handleRoleMenuSelect(
      secondInteraction as never,
      harness.runtime,
    );
    await Promise.resolve();
    expect(harness.guild.members.fetch).toHaveBeenCalledTimes(1);

    releaseAddition();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    expect(harness.member.roles.add).toHaveBeenCalledOnce();
    expect(harness.member.roles.remove).toHaveBeenCalledOnce();
    expect(harness.repository.reserveRoleMenuOperation).toHaveBeenCalledTimes(
      2,
    );
    expect(
      harness.repository.reserveRoleMenuOperation.mock.calls[1]![0],
    ).toMatchObject({ plannedAdds: [], plannedRemovals: [] });
    expect(
      harness.repository.completeRoleMenuOperation,
    ).toHaveBeenLastCalledWith("operation002", {
      state: "no-change",
      addedRoleIds: [],
      removedRoleIds: [],
      failedRoleIds: [],
      skippedRoleIds: [],
    });
    expect(latestContent(secondInteraction)).toContain("already current");
    expect(roleMenuInteractionQueueSize()).toBe(0);
  });

  it("turns repository errors into a bounded recovery response", async () => {
    const harness = createHarness();
    harness.repository.reserveRoleMenuOperation.mockImplementationOnce(() => {
      throw Object.assign(new Error("database is busy"), {
        code: "SQLITE_BUSY",
      });
    });

    await select(harness);

    expect(harness.member.roles.add).not.toHaveBeenCalled();
    expect(harness.member.roles.remove).not.toHaveBeenCalled();
    expect(harness.repository.completeRoleMenuOperation).not.toHaveBeenCalled();
    expect(latestContent(harness.interaction)).toContain(
      "could not safely finish",
    );
    expect(latestContent(harness.interaction)).toContain("role-menu recovery");
    expect(roleMenuInteractionQueueSize()).toBe(0);
  });
});
