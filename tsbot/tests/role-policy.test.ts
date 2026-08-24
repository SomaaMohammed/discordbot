import { PermissionFlagsBits } from "discord.js";
import {
  assignableRoleSafetyIssue,
  prerequisiteRoleSafetyIssue,
} from "../src/discord/role-policy.js";

function role(overrides: Record<string, unknown> = {}) {
  return {
    id: "223456789012345678",
    guild: { id: "123456789012345678" },
    managed: false,
    permissions: { bitfield: 0n },
    ...overrides,
  } as never;
}

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: "323456789012345678",
    user: { bot: true },
    guild: { id: "123456789012345678", ownerId: "423456789012345678" },
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: () => 1 } },
    ...overrides,
  } as never;
}

describe("assignable role policy", () => {
  it("accepts a freshly manageable permissionless role", () => {
    expect(
      assignableRoleSafetyIssue(role(), {
        guildId: "123456789012345678",
        botMember: member(),
      }),
    ).toBeNull();
  });

  it.each([
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.MentionEveryone,
  ])("rejects dangerous permission %s", (permission) => {
    expect(
      assignableRoleSafetyIssue(
        role({ permissions: { bitfield: permission } }),
        { guildId: "123456789012345678", botMember: member() },
      ),
    ).toMatch(/dangerous/u);
  });

  it("rejects managed, cross-guild, hierarchy, and missing bot permission cases", () => {
    expect(
      assignableRoleSafetyIssue(role({ managed: true }), {
        guildId: "123456789012345678",
        botMember: member(),
      }),
    ).toMatch(/Managed/u);
    expect(
      assignableRoleSafetyIssue(role(), {
        guildId: "923456789012345678",
        botMember: member(),
      }),
    ).toMatch(/does not belong/u);
    expect(
      assignableRoleSafetyIssue(role(), {
        guildId: "123456789012345678",
        botMember: member({
          roles: { highest: { comparePositionTo: () => 0 } },
        }),
      }),
    ).toMatch(/highest role/u);
    expect(
      assignableRoleSafetyIssue(role(), {
        guildId: "123456789012345678",
        botMember: member({ permissions: { has: () => false } }),
      }),
    ).toMatch(/Manage Roles/u);
  });

  it("enforces configurator hierarchy except for the owner", () => {
    const actor = member({
      id: "323456789012345678",
      user: { bot: false },
      roles: { highest: { comparePositionTo: () => 0 } },
    });
    expect(
      assignableRoleSafetyIssue(role(), {
        guildId: "123456789012345678",
        botMember: member(),
        actor,
      }),
    ).toMatch(/Your highest role/u);
    const owner = member({
      id: "423456789012345678",
      user: { bot: false },
      roles: { highest: { comparePositionTo: () => 0 } },
    });
    expect(
      assignableRoleSafetyIssue(role(), {
        guildId: "123456789012345678",
        botMember: member(),
        actor: owner,
      }),
    ).toBeNull();
  });

  it("uses a separate bounded prerequisite policy", () => {
    expect(
      prerequisiteRoleSafetyIssue(role(), "123456789012345678"),
    ).toBeNull();
    expect(
      prerequisiteRoleSafetyIssue(
        role({ id: "123456789012345678" }),
        "123456789012345678",
      ),
    ).toMatch(/@everyone/u);
  });
});
