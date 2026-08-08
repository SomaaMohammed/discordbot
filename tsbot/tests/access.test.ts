import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildAccessCommandDefinition } from "../src/discord/access-command.js";
import { handleAccessCommand } from "../src/discord/access-commands-handler.js";
import {
  authorizeCapability,
  authorizeConfiguredRoleOrCapability,
  authorizeReviewerRoleOrCapability,
} from "../src/discord/authorization.js";
import { GUILD_CAPABILITIES } from "../src/discord/capabilities.js";
import type { GuildRuntime } from "../src/runtime.js";
import type { RoleCapabilityGrant } from "../src/types.js";

const GUILD_ID = "111111111111111111";
const OWNER_ID = "222222222222222222";
const ADMIN_ID = "333333333333333333";
const MEMBER_ID = "444444444444444444";
const ROLE_ID = "555555555555555555";

interface GuildHarness {
  guild: Guild;
  member: GuildMember;
  role: Role;
  memberFetch: ReturnType<typeof vi.fn>;
  roleFetch: ReturnType<typeof vi.fn>;
  channelFetch: ReturnType<typeof vi.fn>;
}

function createGuildHarness(
  options: {
    memberId?: string;
    administrator?: boolean;
    roleId?: string;
    roleManaged?: boolean;
    memberRoleIds?: string[];
  } = {},
): GuildHarness {
  const memberId = options.memberId ?? MEMBER_ID;
  const roleId = options.roleId ?? ROLE_ID;
  const guild: Record<string, unknown> = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
  };
  const role = {
    id: roleId,
    name: "Support Leaders",
    managed: options.roleManaged ?? false,
    guild,
  } as unknown as Role;
  const roleIds = options.memberRoleIds ?? [GUILD_ID, roleId];
  const member = {
    id: memberId,
    guild,
    permissions: {
      has: vi.fn(
        (permission: bigint) =>
          permission === PermissionFlagsBits.Administrator &&
          Boolean(options.administrator),
      ),
    },
    roles: { cache: new Map(roleIds.map((id) => [id, { id }])) },
  } as unknown as GuildMember;
  const memberFetch = vi.fn(async (input: string | { user: string }) => {
    const id = typeof input === "string" ? input : input.user;
    return id === memberId ? member : null;
  });
  const roleFetch = vi.fn(async (id: string) => {
    if (id === roleId) return role;
    if (id === GUILD_ID) {
      return {
        id: GUILD_ID,
        name: "@everyone",
        managed: false,
        guild,
      } as unknown as Role;
    }
    return null;
  });
  const channelFetch = vi.fn(async () => null);
  const botMember = {
    id: "999999999999999999",
    guild,
    permissions: { has: vi.fn(() => true) },
    roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
  };
  guild.members = {
    fetch: memberFetch,
    fetchMe: vi.fn(async () => botMember),
  };
  guild.roles = { fetch: roleFetch };
  guild.channels = { fetch: channelFetch };
  return {
    guild: guild as unknown as Guild,
    member,
    role,
    memberFetch,
    roleFetch,
    channelFetch,
  };
}

function createGrant(
  capability: (typeof GUILD_CAPABILITIES)[number],
  roleId = ROLE_ID,
): RoleCapabilityGrant {
  return {
    guildId: GUILD_ID,
    principalType: "role",
    principalId: roleId,
    roleId,
    capability,
    active: true,
    grantedBy: OWNER_ID,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("access command definition", () => {
  it("registers the four Administrator-visible operations and exact capabilities", () => {
    const json = buildAccessCommandDefinition().toJSON();
    expect(json.name).toBe("access");
    expect(json.dm_permission).toBe(false);
    expect(json.default_member_permissions).toBe(
      PermissionFlagsBits.Administrator.toString(),
    );
    expect(json.options?.map(({ name }) => name)).toEqual([
      "grant",
      "revoke",
      "list",
      "status",
    ]);
    for (const operation of ["grant", "revoke"]) {
      const subcommand = json.options?.find(
        ({ name }) => name === operation,
      ) as
        | {
            options?: Array<{
              name: string;
              choices?: Array<{ value: string | number }>;
            }>;
          }
        | undefined;
      const capability = subcommand?.options?.find(
        ({ name }) => name === "capability",
      );
      expect(capability?.choices?.map(({ value }) => value)).toEqual([
        ...GUILD_CAPABILITIES,
      ]);
    }
  });
});

describe("central capability authorization", () => {
  it.each([
    { memberId: OWNER_ID, administrator: false, reason: "owner" },
    { memberId: ADMIN_ID, administrator: true, reason: "administrator" },
  ])(
    "gives $reason precedence when delegated storage is broken",
    async ({ memberId, administrator, reason }) => {
      const harness = createGuildHarness({ memberId, administrator });
      const listCapabilitiesForRoles = vi.fn(() => {
        throw new Error("synthetic delegated storage failure");
      });
      await expect(
        authorizeCapability({
          guild: harness.guild,
          userId: memberId,
          capability: "tickets.manage",
          grants: { listCapabilitiesForRoles },
        }),
      ).resolves.toMatchObject({ allowed: true, reason });
      expect(listCapabilitiesForRoles).not.toHaveBeenCalled();
      expect(harness.memberFetch).toHaveBeenCalledWith({
        user: memberId,
        cache: true,
        force: true,
      });
    },
  );

  it("allows only the capability stored on a freshly verified role", async () => {
    const harness = createGuildHarness();
    const grants = {
      listCapabilitiesForRoles: vi.fn(() => [createGrant("tickets.configure")]),
    };
    await expect(
      authorizeCapability({
        guild: harness.guild,
        userId: MEMBER_ID,
        capability: "tickets.configure",
        grants,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: "delegated",
      roleId: ROLE_ID,
    });
    await expect(
      authorizeCapability({
        guild: harness.guild,
        userId: MEMBER_ID,
        capability: "tickets.manage",
        grants,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "not-authorized" });
    expect(harness.roleFetch).toHaveBeenCalledWith(ROLE_ID, {
      cache: true,
      force: true,
    });
  });

  it.each([
    {
      label: "deleted",
      managed: false,
      result: null,
      reason: "delegated-role-unavailable",
    },
    {
      label: "managed",
      managed: true,
      result: "role",
      reason: "delegated-role-managed",
    },
    {
      label: "cross-guild",
      managed: false,
      result: "cross",
      reason: "delegated-role-mismatch",
    },
  ])(
    "fails closed for a $label delegated role",
    async ({ managed, result, reason }) => {
      const harness = createGuildHarness({ roleManaged: managed });
      if (result === null) harness.roleFetch.mockResolvedValue(null);
      if (result === "cross") {
        harness.roleFetch.mockResolvedValue({
          ...harness.role,
          guild: { id: "999999999999999999" },
        });
      }
      await expect(
        authorizeCapability({
          guild: harness.guild,
          userId: MEMBER_ID,
          capability: "tickets.manage",
          grants: {
            listCapabilitiesForRoles: () => [createGrant("tickets.manage")],
          },
        }),
      ).resolves.toMatchObject({ allowed: false, reason });
    },
  );

  it("shares configured support/reviewer role and delegated capability policy", async () => {
    const configured = createGuildHarness();
    await expect(
      authorizeReviewerRoleOrCapability({
        guild: configured.guild,
        userId: MEMBER_ID,
        configuredRoleId: ROLE_ID,
        capability: "applications.review",
        grants: { listCapabilitiesForRoles: () => [] },
      }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: "reviewer-role",
      roleId: ROLE_ID,
    });

    const delegated = createGuildHarness({ roleId: ROLE_ID });
    await expect(
      authorizeConfiguredRoleOrCapability({
        guild: delegated.guild,
        userId: MEMBER_ID,
        configuredRoleId: "666666666666666666",
        capability: "applications.review",
        grants: {
          listCapabilitiesForRoles: () => [createGrant("applications.review")],
        },
      }),
    ).resolves.toMatchObject({ allowed: true, reason: "delegated" });
  });
});

interface AccessInteractionHarness {
  interaction: Record<string, any>;
  runtime: GuildRuntime;
  storage: Record<string, any>;
  guildHarness: GuildHarness;
}

function createAccessInteraction(options: {
  subcommand: "grant" | "revoke" | "list" | "status";
  memberId?: string;
  administrator?: boolean;
  role?: Role;
  capability?: string;
  page?: number;
}): AccessInteractionHarness {
  const guildHarness = createGuildHarness({
    memberId: options.memberId ?? ADMIN_ID,
    administrator: options.administrator ?? true,
  });
  const storage = {
    grantRoleCapability: vi.fn(() => ({
      status: "granted",
      grant: createGrant("tickets.configure"),
    })),
    revokeRoleCapability: vi.fn(() => ({
      status: "revoked",
      grant: createGrant("tickets.configure"),
    })),
    listCapabilityGrants: vi.fn(() => []),
    listCapabilityGrantsForCapability: vi.fn(() => []),
    listApplicationForms: vi.fn(() => []),
    listCapabilitiesForRoles: vi.fn(() => []),
    recordCommandMetric: vi.fn(),
  };
  const interaction: Record<string, any> = {
    guild: guildHarness.guild,
    guildId: GUILD_ID,
    user: { id: options.memberId ?? ADMIN_ID },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: vi.fn(() => options.subcommand),
      getRole: vi.fn(() => options.role ?? guildHarness.role),
      getString: vi.fn(() => options.capability ?? "tickets.configure"),
      getInteger: vi.fn(() => options.page ?? null),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  const runtime = {
    guildId: GUILD_ID,
    storage,
    isCurrent: vi.fn(() => true),
    invalidate: vi.fn(),
  } as unknown as GuildRuntime;
  return { interaction, runtime, storage, guildHarness };
}

describe("access command handling", () => {
  it("lets the freshly verified server owner grant access without Administrator", async () => {
    const harness = createAccessInteraction({
      subcommand: "grant",
      memberId: OWNER_ID,
      administrator: false,
    });
    await handleAccessCommand(harness.interaction as never, harness.runtime);
    expect(harness.storage.grantRoleCapability).toHaveBeenCalledWith(
      ROLE_ID,
      "tickets.configure",
      OWNER_ID,
    );
  });

  it("freshly verifies an Administrator and target role before granting", async () => {
    const harness = createAccessInteraction({ subcommand: "grant" });
    await handleAccessCommand(harness.interaction as never, harness.runtime);
    expect(harness.guildHarness.memberFetch).toHaveBeenCalledWith({
      user: ADMIN_ID,
      cache: true,
      force: true,
    });
    expect(harness.guildHarness.roleFetch).toHaveBeenCalledWith(ROLE_ID, {
      cache: true,
      force: true,
    });
    expect(harness.storage.grantRoleCapability).toHaveBeenCalledWith(
      ROLE_ID,
      "tickets.configure",
      ADMIN_ID,
    );
    expect(harness.runtime.invalidate).toHaveBeenCalledTimes(1);
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Granted"),
        allowedMentions: { parse: [] },
      }),
    );
  });

  it("refuses application review grants that cannot reach a verified disabled private destination", async () => {
    const harness = createAccessInteraction({
      subcommand: "grant",
      capability: "applications.review",
    });
    harness.storage.listApplicationForms.mockReturnValue([
      {
        guildId: GUILD_ID,
        formId: "form-1",
        slug: "moderator",
        displayName: "Moderator",
        description: "Apply for the moderation team.",
        reviewerRoleId: "666666666666666666",
        reviewChannelId: "777777777777777777",
        enabled: false,
        sortOrder: 0,
        definitionVersion: 1,
        bindingsVerifiedAt: "2026-08-01T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    harness.guildHarness.channelFetch.mockResolvedValue({
      id: "777777777777777777",
      type: ChannelType.GuildText,
      guild: harness.guildHarness.guild,
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => false) })),
    });

    await handleAccessCommand(harness.interaction as never, harness.runtime);

    expect(harness.storage.grantRoleCapability).not.toHaveBeenCalled();
    expect(harness.guildHarness.channelFetch).toHaveBeenCalledWith(
      "777777777777777777",
      { cache: true, force: true },
    );
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("needs View Channel"),
      }),
    );
  });

  it("grants application review after fresh private-destination access checks", async () => {
    const harness = createAccessInteraction({
      subcommand: "grant",
      capability: "applications.review",
    });
    harness.storage.listApplicationForms.mockReturnValue([
      {
        guildId: GUILD_ID,
        formId: "form-1",
        slug: "moderator",
        displayName: "Moderator",
        description: "Apply for the moderation team.",
        reviewerRoleId: "666666666666666666",
        reviewChannelId: "777777777777777777",
        enabled: true,
        sortOrder: 0,
        definitionVersion: 1,
        bindingsVerifiedAt: "2026-08-01T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    harness.guildHarness.channelFetch.mockResolvedValue({
      id: "777777777777777777",
      type: ChannelType.GuildText,
      guild: harness.guildHarness.guild,
      permissionsFor: vi.fn(() => ({ has: vi.fn(() => true) })),
    });

    await handleAccessCommand(harness.interaction as never, harness.runtime);

    expect(harness.storage.grantRoleCapability).toHaveBeenCalledWith(
      ROLE_ID,
      "applications.review",
      ADMIN_ID,
    );
  });

  it("refuses more ticket-management grants than private channels can carry", async () => {
    const harness = createAccessInteraction({
      subcommand: "grant",
      capability: "tickets.manage",
    });
    const grants = Array.from({ length: 25 }, (_, index) =>
      createGrant(
        "tickets.manage",
        (600_000_000_000_000_000n + BigInt(index)).toString(),
      ),
    );
    harness.storage.listCapabilityGrantsForCapability.mockReturnValue(grants);
    const grantedRoleIds = new Set(grants.map(({ roleId }) => roleId));
    harness.guildHarness.roleFetch.mockImplementation(async (id: string) => {
      if (id === ROLE_ID) return harness.guildHarness.role;
      if (grantedRoleIds.has(id)) {
        return {
          id,
          name: `Ticket manager ${id}`,
          managed: false,
          guild: harness.guildHarness.guild,
        };
      }
      return null;
    });

    await handleAccessCommand(harness.interaction as never, harness.runtime);

    expect(harness.storage.grantRoleCapability).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("at most 25"),
      }),
    );
  });

  it("rejects a ticket-management role at or above Superior's hierarchy", async () => {
    const harness = createAccessInteraction({
      subcommand: "grant",
      capability: "tickets.manage",
    });
    vi.mocked(harness.guildHarness.guild.members.fetchMe).mockResolvedValue({
      id: "999999999999999999",
      guild: harness.guildHarness.guild,
      permissions: { has: vi.fn(() => true) },
      roles: { highest: { comparePositionTo: vi.fn(() => 0) } },
    } as never);

    await handleAccessCommand(harness.interaction as never, harness.runtime);

    expect(harness.storage.grantRoleCapability).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("highest role"),
      }),
    );
  });

  it("rechecks Superior's hierarchy after the ticket-manager grant preflight", async () => {
    const harness = createAccessInteraction({
      subcommand: "grant",
      capability: "tickets.manage",
    });
    vi.mocked(harness.guildHarness.guild.members.fetchMe)
      .mockResolvedValueOnce({
        id: "999999999999999999",
        guild: harness.guildHarness.guild,
        permissions: { has: vi.fn(() => true) },
        roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
      } as never)
      .mockResolvedValueOnce({
        id: "999999999999999999",
        guild: harness.guildHarness.guild,
        permissions: { has: vi.fn(() => true) },
        roles: { highest: { comparePositionTo: vi.fn(() => 0) } },
      } as never);

    await handleAccessCommand(harness.interaction as never, harness.runtime);

    expect(harness.guildHarness.guild.members.fetchMe).toHaveBeenCalledTimes(2);
    expect(harness.storage.grantRoleCapability).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("highest role"),
      }),
    );
  });

  it("does not let deleted ticket-manager roles consume the live channel ACL cap", async () => {
    const harness = createAccessInteraction({
      subcommand: "grant",
      capability: "tickets.manage",
    });
    harness.storage.listCapabilityGrantsForCapability.mockReturnValue(
      Array.from({ length: 25 }, (_, index) =>
        createGrant(
          "tickets.manage",
          (700_000_000_000_000_000n + BigInt(index)).toString(),
        ),
      ),
    );

    await handleAccessCommand(harness.interaction as never, harness.runtime);

    expect(harness.storage.grantRoleCapability).toHaveBeenCalledWith(
      ROLE_ID,
      "tickets.manage",
      ADMIN_ID,
    );
  });

  it("rejects duplicate grants without recording a successful command", async () => {
    const harness = createAccessInteraction({ subcommand: "grant" });
    harness.storage.grantRoleCapability.mockReturnValue({
      status: "duplicate",
      grant: createGrant("tickets.configure"),
    });
    await handleAccessCommand(harness.interaction as never, harness.runtime);
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("already has"),
      }),
    );
    expect(harness.storage.recordCommandMetric).not.toHaveBeenCalled();
  });

  it("does not let a delegated non-Administrator mutate access", async () => {
    const harness = createAccessInteraction({
      subcommand: "grant",
      memberId: MEMBER_ID,
      administrator: false,
    });
    harness.storage.listCapabilitiesForRoles.mockReturnValue([
      createGrant("panels.manage"),
    ]);
    await handleAccessCommand(harness.interaction as never, harness.runtime);
    expect(harness.storage.grantRoleCapability).not.toHaveBeenCalled();
    expect(harness.storage.listCapabilitiesForRoles).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("owner or a current Administrator"),
      }),
    );
  });

  it("refuses a grant when Administrator permission disappears before mutation", async () => {
    const harness = createAccessInteraction({ subcommand: "grant" });
    harness.guildHarness.memberFetch
      .mockResolvedValueOnce(harness.guildHarness.member)
      .mockResolvedValueOnce({
        ...harness.guildHarness.member,
        guild: harness.guildHarness.guild,
        permissions: { has: vi.fn(() => false) },
      });
    await handleAccessCommand(harness.interaction as never, harness.runtime);
    expect(harness.storage.grantRoleCapability).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("refuses a grant when the runtime changes after authorization completes", async () => {
    const harness = createAccessInteraction({ subcommand: "grant" });
    vi.mocked(harness.runtime.isCurrent)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await handleAccessCommand(harness.interaction as never, harness.runtime);

    expect(harness.storage.grantRoleCapability).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("after access was verified"),
      }),
    );
  });

  it("refuses a grant when the target role disappears during preflight", async () => {
    const harness = createAccessInteraction({ subcommand: "grant" });
    harness.guildHarness.roleFetch
      .mockResolvedValueOnce(harness.guildHarness.role)
      .mockResolvedValueOnce(null);

    await handleAccessCommand(harness.interaction as never, harness.runtime);

    expect(harness.storage.grantRoleCapability).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("no longer exists"),
      }),
    );
  });

  it.each([
    {
      label: "@everyone",
      prepare: (harness: AccessInteractionHarness) => {
        harness.interaction.options.getRole.mockReturnValue({
          id: GUILD_ID,
          guild: harness.guildHarness.guild,
        });
      },
      message: "@everyone",
    },
    {
      label: "managed",
      prepare: (harness: AccessInteractionHarness) => {
        harness.guildHarness.roleFetch.mockResolvedValue({
          ...harness.guildHarness.role,
          managed: true,
        });
      },
      message: "Managed or integration",
    },
    {
      label: "deleted",
      prepare: (harness: AccessInteractionHarness) => {
        harness.guildHarness.roleFetch.mockResolvedValue(null);
      },
      message: "no longer exists",
    },
    {
      label: "cross-guild",
      prepare: (harness: AccessInteractionHarness) => {
        harness.interaction.options.getRole.mockReturnValue({
          id: ROLE_ID,
          guild: { id: "999999999999999999" },
        });
      },
      message: "does not belong",
    },
  ])("rejects a $label target role", async ({ prepare, message }) => {
    const harness = createAccessInteraction({ subcommand: "grant" });
    prepare(harness);
    await handleAccessCommand(harness.interaction as never, harness.runtime);
    expect(harness.storage.grantRoleCapability).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining(message) }),
    );
  });

  it("revokes an existing role capability", async () => {
    const harness = createAccessInteraction({ subcommand: "revoke" });
    await handleAccessCommand(harness.interaction as never, harness.runtime);
    expect(harness.storage.revokeRoleCapability).toHaveBeenCalledWith(
      ROLE_ID,
      "tickets.configure",
    );
    expect(harness.runtime.invalidate).toHaveBeenCalledTimes(1);
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Revoked") }),
    );
  });

  it("refuses a revoke when the runtime changes after authorization completes", async () => {
    const harness = createAccessInteraction({ subcommand: "revoke" });
    vi.mocked(harness.runtime.isCurrent)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await handleAccessCommand(harness.interaction as never, harness.runtime);

    expect(harness.storage.revokeRoleCapability).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("after access was verified"),
      }),
    );
  });

  it("paginates active grants and reports deleted roles without pinging", async () => {
    const harness = createAccessInteraction({ subcommand: "list", page: 2 });
    harness.storage.listCapabilityGrants.mockReturnValue([
      createGrant("tickets.manage", "777777777777777777"),
    ]);
    await handleAccessCommand(harness.interaction as never, harness.runtime);
    expect(harness.storage.listCapabilityGrants).toHaveBeenCalledWith(11, 10);
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Deleted role"),
        allowedMentions: { parse: [] },
      }),
    );
  });

  it("shows capability isolation in role status", async () => {
    const harness = createAccessInteraction({ subcommand: "status" });
    harness.storage.listCapabilitiesForRoles.mockReturnValue([
      createGrant("suggestions.review"),
    ]);
    await handleAccessCommand(harness.interaction as never, harness.runtime);
    const payload = harness.interaction.editReply.mock.calls[0]?.[0];
    expect(payload.content).toContain("Enabled: `suggestions.review`");
    expect(payload.content).toContain("Not granted: `suggestions.configure`");
  });
});
