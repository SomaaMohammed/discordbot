import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildMember,
  type Role,
  type TextChannel,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type {
  GuildCapability,
  ModerationConfiguration,
  RoleCapabilityGrant,
} from "../src/types.js";
import { inspectSafetyWorkflowResources } from "../src/discord/safety-permissions.js";

const GUILD_ID = "123456789012345678";
const REVIEWER_ID = "223456789012345678";
const DELEGATED_ID = "323456789012345678";
const UNKNOWN_ID = "423456789012345678";
const BOT_ID = "523456789012345678";
const OWNER_ID = "623456789012345678";
const CHANNEL_ID = "723456789012345678";
const SHARED_BOT_ROLE_ID = "823456789012345678";
const BOT_INTEGRATION_ROLE_ID = "923456789012345678";
const ADMIN_ROLE_ID = "103456789012345678";
const ADMIN_MEMBER_ID = "113456789012345678";

function configuration(): ModerationConfiguration {
  return {
    guildId: GUILD_ID,
    casesEnabled: true,
    moderationLogChannelId: null,
    moderationLogVerifiedAt: null,
    reportsEnabled: true,
    reportReviewChannelId: CHANNEL_ID,
    reportReviewerRoleId: REVIEWER_ID,
    reportBindingsVerifiedAt: new Date().toISOString(),
    appealsEnabled: false,
    appealReviewChannelId: null,
    appealReviewerRoleId: null,
    appealBindingsVerifiedAt: null,
    antiSpamEnabled: false,
    reportCooldownLimit: 3,
    reportCooldownWindowSeconds: 1_800,
    createdBy: OWNER_ID,
    updatedBy: OWNER_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function harness(
  viewAllowIds: readonly string[],
  delegated = false,
  options: {
    botRoleIds?: readonly string[];
    integrationRoleIds?: readonly string[];
    adminRoleIds?: readonly string[];
    adminMemberIds?: readonly string[];
  } = {},
) {
  const guild = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
  } as unknown as Guild;
  const role = (id: string) =>
    ({
      id,
      guild,
      managed: options.integrationRoleIds?.includes(id) ?? false,
      tags: options.integrationRoleIds?.includes(id) ? { botId: BOT_ID } : null,
      permissions: new PermissionsBitField(
        options.adminRoleIds?.includes(id)
          ? [PermissionFlagsBits.Administrator]
          : [],
      ),
    }) as unknown as Role;
  const reviewer = role(REVIEWER_ID);
  const delegatedRole = role(DELEGATED_ID);
  const everyone = role(GUILD_ID);
  const bot = {
    id: BOT_ID,
    guild,
    roles: {
      cache: new Collection(
        (options.botRoleIds ?? []).map((id) => [id, role(id)]),
      ),
    },
  } as unknown as GuildMember;
  const access = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ]);
  const overwrites = new Collection(
    viewAllowIds.map((id) => [
      id,
      { id, allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel]) },
    ]),
  );
  const channel = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    guild,
    permissionOverwrites: { cache: overwrites },
    permissionsFor: vi.fn((subject: { id: string }) =>
      subject.id === GUILD_ID ? new PermissionsBitField() : access,
    ),
  } as unknown as TextChannel;
  Object.assign(guild, {
    channels: { fetch: vi.fn(async () => channel) },
    roles: {
      everyone,
      fetch: vi.fn(async (id: string) =>
        id === REVIEWER_ID
          ? reviewer
          : id === DELEGATED_ID
            ? delegatedRole
            : [
                  UNKNOWN_ID,
                  SHARED_BOT_ROLE_ID,
                  BOT_INTEGRATION_ROLE_ID,
                  ADMIN_ROLE_ID,
                ].includes(id)
              ? role(id)
              : null,
      ),
    },
    members: {
      fetchMe: vi.fn(async () => bot),
      fetch: vi.fn(async ({ user }: { user: string }) =>
        options.adminMemberIds?.includes(user)
          ? {
              id: user,
              guild,
              permissions: new PermissionsBitField([
                PermissionFlagsBits.Administrator,
              ]),
            }
          : null,
      ),
    },
  });
  const grant: RoleCapabilityGrant = {
    guildId: GUILD_ID,
    principalType: "role",
    principalId: DELEGATED_ID,
    roleId: DELEGATED_ID,
    capability: "reports.review",
    active: true,
    grantedBy: OWNER_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    guild,
    grants: {
      listCapabilityGrantsForCapability: vi.fn(
        (_capability: GuildCapability) => (delegated ? [grant] : []),
      ),
    },
  };
}

describe("private safety destination boundaries", () => {
  it("accepts only the configured reviewer, bot, owner, and active delegated review roles", async () => {
    const { guild, grants } = harness(
      [REVIEWER_ID, BOT_ID, OWNER_ID, DELEGATED_ID],
      true,
    );
    const resources = await inspectSafetyWorkflowResources(
      guild,
      configuration(),
      "reports",
      grants,
    );
    expect(resources.issues).toEqual([]);
  });

  it("rejects an unrelated View Channel allow overwrite", async () => {
    const { guild, grants } = harness([REVIEWER_ID, BOT_ID, UNKNOWN_ID], false);
    const resources = await inspectSafetyWorkflowResources(
      guild,
      configuration(),
      "reports",
      grants,
    );
    expect(resources.issues).toContainEqual(
      expect.stringContaining("unrelated role or member overwrites"),
    );
  });

  it("rejects an ordinary shared role merely because the bot also holds it", async () => {
    const { guild, grants } = harness(
      [REVIEWER_ID, BOT_ID, SHARED_BOT_ROLE_ID],
      false,
      { botRoleIds: [SHARED_BOT_ROLE_ID] },
    );

    const resources = await inspectSafetyWorkflowResources(
      guild,
      configuration(),
      "reports",
      grants,
    );

    expect(resources.issues).toContainEqual(
      expect.stringContaining("unrelated role or member overwrites"),
    );
  });

  it("allows the bot integration role and freshly verified Administrator principals", async () => {
    const { guild, grants } = harness(
      [
        REVIEWER_ID,
        BOT_ID,
        BOT_INTEGRATION_ROLE_ID,
        ADMIN_ROLE_ID,
        ADMIN_MEMBER_ID,
      ],
      false,
      {
        botRoleIds: [BOT_INTEGRATION_ROLE_ID],
        integrationRoleIds: [BOT_INTEGRATION_ROLE_ID],
        adminRoleIds: [ADMIN_ROLE_ID],
        adminMemberIds: [ADMIN_MEMBER_ID],
      },
    );

    const resources = await inspectSafetyWorkflowResources(
      guild,
      configuration(),
      "reports",
      grants,
    );

    expect(resources.issues).toEqual([]);
  });
});
