import { PermissionFlagsBits, type GuildMember, type Role } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  canManagePanels,
  evaluatePanelManagement,
  evaluateTicketConfiguration,
  evaluateTicketStaff,
  getVerifiedAuthorizationFacts,
  isTicketStaff,
  validateSupportRole,
  type AuthorizationPolicyContext,
  type TicketStaffAuthorizationContext,
} from "../src/discord/ticket-authorization.js";

const GUILD_ID = "123456789012345678";
const OWNER_ID = "223456789012345678";
const MEMBER_ID = "323456789012345678";
const SUPPORT_ROLE_ID = "423456789012345678";

function createMember(
  options: {
    id?: string;
    guildId?: string;
    ownerId?: string;
    administrator?: boolean;
    roleIds?: string[];
  } = {},
): GuildMember {
  const guildId = options.guildId ?? GUILD_ID;
  return {
    id: options.id ?? MEMBER_ID,
    guild: {
      id: guildId,
      ownerId: options.ownerId ?? OWNER_ID,
    },
    permissions: {
      has: vi.fn(
        (permission: bigint) =>
          permission === PermissionFlagsBits.Administrator &&
          (options.administrator ?? false),
      ),
    },
    roles: {
      cache: new Map(
        (options.roleIds ?? [guildId]).map((roleId) => [
          roleId,
          { id: roleId },
        ]),
      ),
    },
  } as unknown as GuildMember;
}

function createRole(
  options: {
    id?: string;
    guildId?: string;
    managed?: boolean;
  } = {},
): Role {
  return {
    id: options.id ?? SUPPORT_ROLE_ID,
    guild: { id: options.guildId ?? GUILD_ID },
    managed: options.managed ?? false,
  } as unknown as Role;
}

function managerContext(
  member: GuildMember | null,
  options: { guildId?: string; ownerId?: string } = {},
): AuthorizationPolicyContext {
  return {
    guildId: options.guildId ?? GUILD_ID,
    ownerId: options.ownerId ?? OWNER_ID,
    member,
  };
}

function staffContext(
  member: GuildMember | null,
  options: {
    supportRoleId?: string | null;
    supportRole?: Role | null;
  } = {},
): TicketStaffAuthorizationContext {
  return {
    ...managerContext(member),
    supportRoleId: options.supportRoleId ?? SUPPORT_ROLE_ID,
    supportRole:
      options.supportRole === undefined ? createRole() : options.supportRole,
  };
}

describe("ticket and panel authorization policy", () => {
  it.each([
    {
      label: "server owner",
      member: createMember({ id: OWNER_ID }),
      reason: "owner",
    },
    {
      label: "Administrator",
      member: createMember({ administrator: true }),
      reason: "administrator",
    },
  ])("allows the $label to manage configuration", ({ member, reason }) => {
    const context = managerContext(member);
    expect(evaluatePanelManagement(context)).toEqual({
      allowed: true,
      reason,
    });
    expect(evaluateTicketConfiguration(context)).toEqual({
      allowed: true,
      reason,
    });
    expect(canManagePanels(context)).toBe(true);
  });

  it("denies ordinary members and unverifiable member facts", () => {
    expect(evaluatePanelManagement(managerContext(createMember()))).toEqual({
      allowed: false,
      reason: "not-authorized",
    });
    expect(evaluatePanelManagement(managerContext(null))).toEqual({
      allowed: false,
      reason: "member-unavailable",
    });
    expect(
      evaluatePanelManagement(
        managerContext(createMember({ guildId: "999999999999999999" })),
      ),
    ).toEqual({ allowed: false, reason: "guild-mismatch" });
    expect(
      evaluatePanelManagement(
        managerContext(createMember(), {
          ownerId: "999999999999999999",
        }),
      ),
    ).toEqual({ allowed: false, reason: "owner-mismatch" });
  });

  it("allows a current member of the configured support role", () => {
    const context = staffContext(
      createMember({ roleIds: [GUILD_ID, SUPPORT_ROLE_ID] }),
    );
    expect(evaluateTicketStaff(context)).toEqual({
      allowed: true,
      reason: "support-role",
    });
    expect(isTicketStaff(context)).toBe(true);
  });

  it("keeps owner and Administrator recovery access when the role disappeared", () => {
    expect(
      evaluateTicketStaff(
        staffContext(createMember({ id: OWNER_ID }), {
          supportRole: null,
        }),
      ),
    ).toEqual({ allowed: true, reason: "owner" });
    expect(
      evaluateTicketStaff(
        staffContext(createMember({ administrator: true }), {
          supportRole: null,
        }),
      ),
    ).toEqual({ allowed: true, reason: "administrator" });
  });

  it("validates support-role identity and rejects unsafe roles", () => {
    expect(validateSupportRole(GUILD_ID, null, null)).toEqual({
      valid: false,
      reason: "support-role-unavailable",
    });
    expect(
      validateSupportRole(
        GUILD_ID,
        SUPPORT_ROLE_ID,
        createRole({ guildId: "999999999999999999" }),
      ),
    ).toEqual({ valid: false, reason: "support-role-mismatch" });
    expect(
      validateSupportRole(
        GUILD_ID,
        SUPPORT_ROLE_ID,
        createRole({ id: GUILD_ID }),
      ),
    ).toEqual({ valid: false, reason: "support-role-mismatch" });
    expect(
      validateSupportRole(GUILD_ID, GUILD_ID, createRole({ id: GUILD_ID })),
    ).toEqual({ valid: false, reason: "support-role-everyone" });
    expect(
      validateSupportRole(
        GUILD_ID,
        SUPPORT_ROLE_ID,
        createRole({ managed: true }),
      ),
    ).toEqual({ valid: false, reason: "support-role-managed" });
  });

  it("does not treat a stale or invalid configured role as staff membership", () => {
    const member = createMember({ roleIds: [GUILD_ID, SUPPORT_ROLE_ID] });
    expect(
      evaluateTicketStaff(staffContext(member, { supportRole: null })),
    ).toEqual({ allowed: false, reason: "support-role-unavailable" });
    expect(
      evaluateTicketStaff(
        staffContext(member, { supportRole: createRole({ managed: true }) }),
      ),
    ).toEqual({ allowed: false, reason: "support-role-managed" });
  });

  it("exposes verified facts to future delegated-policy extensions", () => {
    const member = createMember({ roleIds: [GUILD_ID, "delegated-role"] });
    const delegatedManager = vi.fn((facts: { roleIds: ReadonlySet<string> }) =>
      facts.roleIds.has("delegated-role"),
    );
    const delegatedStaff = vi.fn(() => true);

    expect(
      evaluatePanelManagement(managerContext(member), {
        isDelegatedManager: delegatedManager,
      }),
    ).toEqual({ allowed: true, reason: "delegated" });
    expect(
      evaluateTicketStaff(staffContext(member), {
        isDelegatedTicketStaff: delegatedStaff,
      }),
    ).toEqual({ allowed: true, reason: "delegated" });
    expect(delegatedManager).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: GUILD_ID,
        ownerId: OWNER_ID,
        memberId: MEMBER_ID,
        isOwner: false,
        isAdministrator: false,
      }),
    );
    expect(delegatedStaff).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: MEMBER_ID }),
      expect.objectContaining({ roleId: SUPPORT_ROLE_ID }),
    );
  });

  it("fails closed before extensions when guild facts cannot be verified", () => {
    const extension = vi.fn(() => true);
    const result = evaluatePanelManagement(
      managerContext(createMember({ guildId: "999999999999999999" })),
      { isDelegatedManager: extension },
    );
    expect(result).toEqual({ allowed: false, reason: "guild-mismatch" });
    expect(extension).not.toHaveBeenCalled();
    expect(
      getVerifiedAuthorizationFacts(managerContext(createMember())).valid,
    ).toBe(true);
  });
});
