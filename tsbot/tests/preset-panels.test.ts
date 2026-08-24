import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import type { GuildRuntime } from "../src/runtime.js";
import {
  handlePresetPanelCommand,
  panelCapabilityForOperation,
} from "../src/discord/preset-panels.js";
import { handleOnboardingCommand } from "../src/discord/onboarding-commands-handler.js";

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "223456789012345678";
const MESSAGE_ID = "323456789012345678";
const BOT_ID = "423456789012345678";
const ACTOR_ID = "523456789012345678";
const REPORT_CHANNEL_ID = "623456789012345678";
const APPEAL_CHANNEL_ID = "723456789012345678";
const REPORT_ROLE_ID = "823456789012345678";
const APPEAL_ROLE_ID = "923456789012345678";
const VERIFIED_ROLE_ID = "103456789012345678";
const UNVERIFIED_ROLE_ID = "113456789012345678";
const MENU_ROLE_ID = "133456789012345678";
const REQUIRED_ROLE_ID = "143456789012345678";
const MENU_ID = "menuABCD1234";
const OPTION_ID = "optionABCD12";
const NOW = "2026-08-13T00:00:00.000Z";

function createHarness(existing = false) {
  const permissions = {
    has: vi.fn(
      (permission: bigint) =>
        permission === PermissionFlagsBits.ViewChannel ||
        permission === PermissionFlagsBits.SendMessages ||
        permission === PermissionFlagsBits.ReadMessageHistory ||
        permission === PermissionFlagsBits.EmbedLinks,
    ),
  };
  const botMember: Record<string, any> = {
    id: BOT_ID,
    guild: { id: GUILD_ID },
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
  const priorEdit = vi.fn(async () => undefined);
  const prior = {
    id: MESSAGE_ID,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    author: { id: BOT_ID, bot: true },
    embeds: [],
    components: [],
    edit: priorEdit,
  };
  const postedDelete = vi.fn(async () => undefined);
  const sentEdit = vi.fn(async () => undefined);
  const messages = new Map<string, Record<string, any>>();
  if (existing) messages.set(MESSAGE_ID, prior);
  const channel: Record<string, any> = {
    id: CHANNEL_ID,
    type: ChannelType.GuildText,
    isDMBased: vi.fn(() => false),
    isThread: vi.fn(() => false),
    permissionsFor: vi.fn(() => permissions),
    messages: {
      fetch: vi.fn(async (id: string) => messages.get(id) ?? null),
    },
    send: vi.fn(async () => {
      const message = {
        id: MESSAGE_ID,
        guildId: GUILD_ID,
        channelId: CHANNEL_ID,
        author: { id: BOT_ID, bot: true },
        embeds: [],
        components: [],
        edit: sentEdit,
        delete: postedDelete,
      };
      messages.set(MESSAGE_ID, message);
      return message;
    }),
  };
  const guild: Record<string, any> = {
    id: GUILD_ID,
    name: "Panel Server",
    ownerId: ACTOR_ID,
    memberCount: 20,
    createdTimestamp: Date.now(),
    premiumSubscriptionCount: 0,
    premiumTier: 0,
    iconURL: vi.fn(() => null),
    channels: {
      cache: new Map([[CHANNEL_ID, channel]]),
      fetch: vi.fn(async (id: string) => (id === CHANNEL_ID ? channel : null)),
    },
    roles: { cache: new Collection() },
    members: { me: botMember, fetchMe: vi.fn(async () => botMember) },
  };
  botMember.guild = guild;
  channel.guild = guild;
  let tracked = existing
    ? {
        guildId: GUILD_ID,
        panelId: "existing_panel",
        preset: "help",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        configuration: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    : null;
  const storage = {
    getTicketConfiguration: vi.fn(() => null),
    findPostedPanelByPresetAndChannel: vi.fn(() => tracked),
    upsertPostedPanel: vi.fn((input) => {
      tracked = {
        guildId: GUILD_ID,
        ...input,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return tracked;
    }),
    recordCommandMetric: vi.fn(),
    listPostedPanels: vi.fn(() => (tracked ? [tracked] : [])),
    countPostedPanels: vi.fn((): number => (tracked ? 1 : 0)),
    listCapabilitiesForRoles: vi.fn(() => []),
  };
  const settings = createDefaultGuildSettings();
  settings.enabled = true;
  const runtime = {
    guildId: GUILD_ID,
    storage,
    settings,
    isCurrent: vi.fn(() => true),
  } as unknown as GuildRuntime;
  const interaction: Record<string, any> = {
    id: "panel_interaction_1",
    guild,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    client: { user: { id: BOT_ID } },
    user: { id: ACTOR_ID },
    options: {
      getSubcommand: vi.fn(() => "post"),
      getString: vi.fn((name: string) => (name === "preset" ? "help" : null)),
      getChannel: vi.fn(() => channel),
      getBoolean: vi.fn(() => true),
    },
    deferred: true,
    replied: false,
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  const actor = {
    id: ACTOR_ID,
    guild,
    permissions: { has: vi.fn(() => false) },
    roles: {
      cache: new Collection(),
      highest: { comparePositionTo: vi.fn(() => 1) },
    },
  };
  guild.members.fetch = vi.fn(async () => actor);
  return {
    channel,
    priorEdit,
    postedDelete,
    sentEdit,
    storage,
    runtime,
    interaction,
    actor,
    botMember,
  };
}

function createRole(
  guild: Record<string, any>,
  id: string,
): Record<string, any> {
  return {
    id,
    guild,
    managed: false,
    permissions: { bitfield: 0n },
  };
}

function configureVerificationHarness(
  harness: ReturnType<typeof createHarness>,
) {
  const guild = harness.interaction.guild as Record<string, any>;
  const verifiedRole = createRole(guild, VERIFIED_ROLE_ID);
  const unverifiedRole = createRole(guild, UNVERIFIED_ROLE_ID);
  const roles = new Map([
    [VERIFIED_ROLE_ID, verifiedRole],
    [UNVERIFIED_ROLE_ID, unverifiedRole],
  ]);
  guild.roles.fetch = vi.fn(async (id: string) => roles.get(id) ?? null);
  const configuration = {
    guildId: GUILD_ID,
    enabled: true,
    welcomeChannelId: null,
    welcomePublicEnabled: false,
    welcomeDmEnabled: false,
    farewellChannelId: null,
    farewellPublicEnabled: false,
    lifecycleLogChannelId: null,
    rulesChannelId: null,
    verificationEnabled: true,
    currentRulesVersion: 3,
    verifiedRoleId: VERIFIED_ROLE_ID,
    unverifiedRoleId: UNVERIFIED_ROLE_ID,
    humanAutorolesEnabled: false,
    botAutorolesEnabled: false,
    accountAgeAlertHours: null,
    welcomeTitle: "Welcome",
    welcomeBody: "Welcome",
    farewellTitle: "Farewell",
    farewellBody: "Farewell",
    welcomeChannelVerifiedAt: null,
    farewellChannelVerifiedAt: null,
    lifecycleLogChannelVerifiedAt: null,
    rulesChannelVerifiedAt: null,
    verificationRolesVerifiedAt: NOW,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const rules = {
    guildId: GUILD_ID,
    rulesVersion: 3,
    title: "Server Rules",
    body: "Be respectful and follow staff directions.",
    reacceptanceRequested: false,
    createdBy: ACTOR_ID,
    createdAt: NOW,
  };
  Object.assign(harness.storage, {
    getOnboardingConfiguration: vi.fn(() => configuration),
    getCurrentOnboardingRulesVersion: vi.fn(() => rules),
  });
  harness.interaction.options.getString = vi.fn((name: string) =>
    name === "preset" ? "verification" : null,
  );
  return { configuration, rules, verifiedRole, unverifiedRole };
}

function configureRoleMenuHarness(harness: ReturnType<typeof createHarness>) {
  const guild = harness.interaction.guild as Record<string, any>;
  const menuRole = createRole(guild, MENU_ROLE_ID);
  const requiredRole = createRole(guild, REQUIRED_ROLE_ID);
  const roles = new Map([
    [MENU_ROLE_ID, menuRole],
    [REQUIRED_ROLE_ID, requiredRole],
  ]);
  guild.roles.fetch = vi.fn(async (id: string) => roles.get(id) ?? null);
  const menu = {
    guildId: GUILD_ID,
    menuId: MENU_ID,
    slug: "colors",
    title: "Color roles",
    description: "Choose a color for your name.",
    state: "enabled" as const,
    mode: "toggle" as const,
    minSelections: 0,
    maxSelections: 1,
    requiredRoleId: REQUIRED_ROLE_ID,
    definitionVersion: 4,
    bindingsVerifiedAt: NOW,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const options = [
    {
      guildId: GUILD_ID,
      menuId: MENU_ID,
      optionId: OPTION_ID,
      roleId: MENU_ROLE_ID,
      label: "Gold",
      description: "Use the gold color.",
      emoji: "🟡",
      sortOrder: 0,
      createdBy: ACTOR_ID,
      updatedBy: ACTOR_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  let post: Record<string, any> | null = null;
  const upsertRoleMenuPost = vi.fn((input: Record<string, any>) => {
    post = {
      guildId: GUILD_ID,
      ...input,
      createdAt: post?.createdAt ?? NOW,
      updatedAt: NOW,
    };
    return post;
  });
  const setRoleMenuPostState = vi.fn(
    (postId: string, state: string, bindingsVerifiedAt: string | null) => {
      if (!post || post.postId !== postId) return null;
      post = { ...post, state, bindingsVerifiedAt, updatedAt: NOW };
      return post;
    },
  );
  Object.assign(harness.storage, {
    getRoleMenuBySlug: vi.fn((slug: string) =>
      slug === menu.slug ? menu : null,
    ),
    getRoleMenuById: vi.fn((menuId: string) =>
      menuId === menu.menuId ? menu : null,
    ),
    listRoleMenuOptions: vi.fn((menuId: string) =>
      menuId === menu.menuId ? options : [],
    ),
    getRoleMenuPostById: vi.fn((postId: string) =>
      post?.postId === postId ? post : null,
    ),
    upsertRoleMenuPost,
    setRoleMenuPostState,
  });
  harness.interaction.options.getString = vi.fn((name: string) => {
    if (name === "preset") return "roles";
    if (name === "role_menu") return menu.slug;
    return null;
  });
  return {
    menu,
    options,
    menuRole,
    requiredRole,
    upsertRoleMenuPost,
    setRoleMenuPostState,
  };
}

function configureSafetyHarness(
  harness: ReturnType<typeof createHarness>,
  options: { reportsSafe: boolean; appealsSafe: boolean },
): void {
  const guild = harness.interaction.guild as Record<string, any>;
  const botMember = guild.members.me;
  const everyoneRole: Record<string, any> = {
    id: GUILD_ID,
    guild,
    managed: false,
  };
  const reportRole: Record<string, any> = {
    id: REPORT_ROLE_ID,
    guild,
    managed: false,
  };
  const appealRole: Record<string, any> = {
    id: APPEAL_ROLE_ID,
    guild,
    managed: false,
  };
  const roles = new Map([
    [REPORT_ROLE_ID, reportRole],
    [APPEAL_ROLE_ID, appealRole],
  ]);
  guild.roles.everyone = everyoneRole;
  guild.roles.fetch = vi.fn(async (id: string) => roles.get(id) ?? null);

  const reviewChannel = (
    id: string,
    reviewerRoleId: string,
    safe: boolean,
  ): Record<string, any> => ({
    id,
    type: ChannelType.GuildText,
    guild,
    permissionOverwrites: { cache: new Collection() },
    permissionsFor: vi.fn((subject: { id: string }) => ({
      has: vi.fn((permission: bigint) => {
        if (subject.id === GUILD_ID) {
          return !safe && permission === PermissionFlagsBits.ViewChannel;
        }
        if (subject.id === botMember.id) {
          return [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
          ].includes(permission);
        }
        if (subject.id === reviewerRoleId) {
          return [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ].includes(permission);
        }
        return false;
      }),
    })),
  });
  const reportChannel = reviewChannel(
    REPORT_CHANNEL_ID,
    REPORT_ROLE_ID,
    options.reportsSafe,
  );
  const appealChannel = reviewChannel(
    APPEAL_CHANNEL_ID,
    APPEAL_ROLE_ID,
    options.appealsSafe,
  );
  const channels = new Map([
    [REPORT_CHANNEL_ID, reportChannel],
    [APPEAL_CHANNEL_ID, appealChannel],
  ]);
  guild.channels.fetch = vi.fn(async (id: string) => channels.get(id) ?? null);

  const now = "2026-08-13T00:00:00.000Z";
  (harness.storage as any).getModerationConfiguration = vi.fn(() => ({
    guildId: GUILD_ID,
    casesEnabled: true,
    moderationLogChannelId: null,
    moderationLogVerifiedAt: null,
    reportsEnabled: true,
    reportReviewChannelId: REPORT_CHANNEL_ID,
    reportReviewerRoleId: REPORT_ROLE_ID,
    reportBindingsVerifiedAt: now,
    appealsEnabled: true,
    appealReviewChannelId: APPEAL_CHANNEL_ID,
    appealReviewerRoleId: APPEAL_ROLE_ID,
    appealBindingsVerifiedAt: now,
    antiSpamEnabled: false,
    reportCooldownLimit: 3,
    reportCooldownWindowSeconds: 1_800,
    createdBy: ACTOR_ID,
    updatedBy: ACTOR_ID,
    createdAt: now,
    updatedAt: now,
  }));
  (harness.storage as any).listCapabilityGrantsForCapability = vi.fn(() => []);
  harness.interaction.options.getString = vi.fn((name: string) =>
    name === "preset" ? "safety" : null,
  );
}

describe("safety panel authorization", () => {
  it("maps sensitive presets to their isolated configuration capabilities", () => {
    expect(panelCapabilityForOperation("post", "safety")).toBe(
      "moderation.configure",
    );
    expect(panelCapabilityForOperation("post", "verification")).toBe(
      "onboarding.configure",
    );
    expect(panelCapabilityForOperation("post", "roles")).toBe(
      "roles.configure",
    );
    expect(panelCapabilityForOperation("post", "help")).toBe("panels.manage");
    expect(panelCapabilityForOperation("list", null)).toBe("panels.manage");
    expect(panelCapabilityForOperation("status", null)).toBe("panels.manage");
  });
});

describe("preset panel delivery", () => {
  it("enables only workflows whose private resources pass fresh inspection", async () => {
    const harness = createHarness();
    configureSafetyHarness(harness, {
      reportsSafe: true,
      appealsSafe: false,
    });

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    const payload = harness.channel.send.mock.calls[0]![0] as {
      components: Array<{
        toJSON(): { components: Array<{ disabled?: boolean }> };
      }>;
    };
    const controls = payload.components[0]!.toJSON().components;
    expect(controls[0]?.disabled).toBe(false);
    expect(controls[1]?.disabled).toBe(true);
    expect(harness.interaction.guild.channels.fetch).toHaveBeenCalledWith(
      REPORT_CHANNEL_ID,
      { cache: true, force: true },
    );
    expect(harness.interaction.guild.channels.fetch).toHaveBeenCalledWith(
      APPEAL_CHANNEL_ID,
      { cache: true, force: true },
    );
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("appeals controls stayed disabled"),
      }),
    );
  });

  it("refuses to post when no configured safety workflow remains private", async () => {
    const harness = createHarness();
    configureSafetyHarness(harness, {
      reportsSafe: false,
      appealsSafe: false,
    });

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Configure and verify private report"),
      }),
    );
  });

  it("rechecks moderation.configure authority after readiness inspection", async () => {
    const harness = createHarness();
    configureSafetyHarness(harness, {
      reportsSafe: true,
      appealsSafe: true,
    });
    harness.interaction.guild.members.fetch.mockResolvedValueOnce(null);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("authority changed"),
      }),
    );
  });

  it("bounds panel status rows and reports when more bindings exist", async () => {
    const harness = createHarness();
    const panels = Array.from({ length: 20 }, (_, index) => ({
      guildId: GUILD_ID,
      panelId: `panel_${String(index).padStart(2, "0")}`,
      preset: "help" as const,
      channelId: CHANNEL_ID,
      messageId: `${MESSAGE_ID.slice(0, -2)}${String(index).padStart(2, "0")}`,
      configuration: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    harness.interaction.options.getSubcommand = vi.fn(() => "status");
    harness.storage.listPostedPanels.mockReturnValue(panels);
    harness.storage.countPostedPanels.mockReturnValue(21);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.storage.listPostedPanels).toHaveBeenCalledWith(
      undefined,
      20,
      0,
    );
    expect(harness.storage.countPostedPanels).toHaveBeenCalledOnce();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("20+ of 21"),
      }),
    );
  });

  it("reports a current Phase 4 binding as missing when its Discord message is gone", async () => {
    const harness = createHarness();
    configureVerificationHarness(harness);
    harness.interaction.options.getSubcommand = vi.fn(() => "status");
    harness.storage.listPostedPanels.mockReturnValue([
      {
        guildId: GUILD_ID,
        panelId: "verifyPanel01",
        preset: "verification",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        configuration: { rulesVersion: 3, bindingsVerifiedAt: NOW },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    harness.storage.countPostedPanels.mockReturnValue(1);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.interaction.guild.channels.fetch).toHaveBeenCalledWith(
      CHANNEL_ID,
      { cache: true, force: true },
    );
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("binding **missing**"),
      }),
    );
  });

  it("reports a current Phase 4 binding as stale when its controls no longer match", async () => {
    const harness = createHarness();
    configureVerificationHarness(harness);
    harness.interaction.options.getSubcommand = vi.fn(() => "status");
    harness.storage.listPostedPanels.mockReturnValue([
      {
        guildId: GUILD_ID,
        panelId: "verifyPanel01",
        preset: "verification",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        configuration: { rulesVersion: 3, bindingsVerifiedAt: NOW },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    harness.storage.countPostedPanels.mockReturnValue(1);
    harness.channel.messages.fetch.mockResolvedValue({
      id: MESSAGE_ID,
      guildId: GUILD_ID,
      channelId: CHANNEL_ID,
      author: { id: BOT_ID, bot: true },
      components: [
        {
          components: [{ customId: "superior:verify:verifyPanel01:2" }],
        },
      ],
    });

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("binding **stale**"),
      }),
    );
  });

  it("posts a fixed themed preset and persists its Discord binding", async () => {
    const harness = createHarness();

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: [
          expect.objectContaining({
            data: expect.objectContaining({ color: 0xd4af37 }),
          }),
        ],
        allowedMentions: { parse: [] },
      }),
    );
    expect(harness.storage.upsertPostedPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "help",
        channelId: CHANNEL_ID,
        messageId: MESSAGE_ID,
        panelId: expect.any(String),
      }),
    );
  });

  it("refuses a second tracked panel when replacement is disabled", async () => {
    const harness = createHarness(true);
    harness.interaction.options.getBoolean.mockReturnValue(false);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.priorEdit).not.toHaveBeenCalled();
    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("already tracked"),
      }),
    );
  });

  it("posts only the current verified rules and persists the exact binding snapshot", async () => {
    const harness = createHarness();
    configureVerificationHarness(harness);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    const payload = harness.channel.send.mock.calls[0]![0] as {
      components: Array<{
        toJSON(): { components: Array<{ custom_id?: string }> };
      }>;
    };
    const customId = payload.components[0]!.toJSON().components[0]!.custom_id;
    expect(customId).toMatch(/^superior:verify:[A-Za-z0-9_-]{8,24}:3$/u);
    const persisted = harness.storage.upsertPostedPanel.mock.calls[0]![0] as {
      panelId: string;
      configuration: unknown;
    };
    expect(persisted.configuration).toEqual({
      rulesVersion: 3,
      bindingsVerifiedAt: NOW,
    });
    expect(customId).toContain(`:${persisted.panelId}:3`);
    expect(harness.interaction.guild.roles.fetch).toHaveBeenCalledWith(
      VERIFIED_ROLE_ID,
      { cache: true, force: true },
    );
    expect(harness.interaction.guild.roles.fetch).toHaveBeenCalledWith(
      UNVERIFIED_ROLE_ID,
      { cache: true, force: true },
    );
    expect(harness.interaction.guild.channels.fetch).toHaveBeenCalledWith(
      CHANNEL_ID,
      { cache: true, force: true },
    );
    expect(harness.interaction.guild.members.fetchMe).toHaveBeenLastCalledWith({
      cache: true,
      force: true,
    });
  });

  it.each([
    {
      label: "a channel that moved outside the server",
      createFreshChannel: (harness: ReturnType<typeof createHarness>) => ({
        ...harness.channel,
        guild: { id: "993456789012345678" },
      }),
    },
    {
      label: "a channel that is no longer text based",
      createFreshChannel: (harness: ReturnType<typeof createHarness>) => ({
        ...harness.channel,
        type: ChannelType.GuildVoice,
      }),
    },
  ])(
    "rejects $label after refreshing the verification target",
    async ({ createFreshChannel }) => {
      const harness = createHarness();
      configureVerificationHarness(harness);
      harness.interaction.guild.channels.fetch.mockResolvedValueOnce(
        createFreshChannel(harness),
      );

      await handlePresetPanelCommand(
        harness.interaction as never,
        harness.runtime,
        harness.actor as never,
      );

      expect(harness.interaction.guild.channels.fetch).toHaveBeenCalledWith(
        CHANNEL_ID,
        { cache: true, force: true },
      );
      expect(harness.channel.send).not.toHaveBeenCalled();
      expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
      expect(harness.interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(
            "no longer a text or announcement channel",
          ),
        }),
      );
    },
  );

  it("rejects an unverified verification-role binding timestamp", async () => {
    const harness = createHarness();
    const { configuration } = configureVerificationHarness(harness);
    configuration.verificationRolesVerifiedAt = "not-a-timestamp";

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("verified role bindings"),
      }),
    );
  });

  it("posts a stored verified role menu with one stable binding token", async () => {
    const harness = createHarness();
    const { menu, upsertRoleMenuPost } = configureRoleMenuHarness(harness);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    const payload = harness.channel.send.mock.calls[0]![0] as {
      components: Array<{
        toJSON(): { components: Array<{ custom_id?: string }> };
      }>;
    };
    const customId = payload.components[0]!.toJSON().components[0]!.custom_id;
    const panelBinding = harness.storage.upsertPostedPanel.mock
      .calls[0]![0] as {
      panelId: string;
      configuration: {
        menuId: string;
        postId: string;
        definitionVersion: number;
        bindingsVerifiedAt: string;
      };
    };
    const roleBinding = upsertRoleMenuPost.mock.calls[0]![0];
    expect(customId).toBe(
      `superior:rolemenu:${menu.menuId}:${panelBinding.panelId}:${menu.definitionVersion}`,
    );
    expect(roleBinding).toEqual({
      postId: panelBinding.panelId,
      menuId: menu.menuId,
      channelId: CHANNEL_ID,
      messageId: MESSAGE_ID,
      definitionVersion: menu.definitionVersion,
      bindingsVerifiedAt: panelBinding.configuration.bindingsVerifiedAt,
      state: "active",
    });
    expect(panelBinding.configuration).toEqual({
      menuId: menu.menuId,
      postId: panelBinding.panelId,
      definitionVersion: menu.definitionVersion,
      bindingsVerifiedAt: expect.any(String),
    });
    expect(Number.isFinite(Date.parse(roleBinding.bindingsVerifiedAt))).toBe(
      true,
    );
    expect(harness.interaction.guild.roles.fetch).toHaveBeenCalledWith(
      MENU_ROLE_ID,
      { cache: true, force: true },
    );
    expect(harness.interaction.guild.roles.fetch).toHaveBeenCalledWith(
      REQUIRED_ROLE_ID,
      { cache: true, force: true },
    );
  });

  it("uses the freshly fetched bot member for final role-panel permissions", async () => {
    const harness = createHarness();
    configureRoleMenuHarness(harness);
    const freshBotMember = {
      ...harness.botMember,
      roles: {
        cache: new Collection(),
        highest: { comparePositionTo: vi.fn(() => 1) },
      },
    };
    const deniedPermissions = { has: vi.fn(() => false) };
    const freshChannel = {
      ...harness.channel,
      permissionsFor: vi.fn((member: unknown) =>
        member === freshBotMember ? deniedPermissions : null,
      ),
    };
    harness.interaction.guild.channels.fetch.mockResolvedValue(freshChannel);
    harness.interaction.guild.members.fetchMe.mockResolvedValue(freshBotMember);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(freshChannel.permissionsFor).toHaveBeenCalledWith(freshBotMember);
    expect(harness.interaction.guild.members.fetchMe).toHaveBeenLastCalledWith({
      cache: true,
      force: true,
    });
    expect(harness.channel.permissionsFor).not.toHaveBeenCalled();
    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Superior needs View Channel"),
      }),
    );
  });

  it("requires role_menu before attempting to post the roles preset", async () => {
    const harness = createHarness();
    harness.interaction.options.getString = vi.fn((name: string) =>
      name === "preset" ? "roles" : null,
    );

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("role_menu"),
      }),
    );
  });

  it("rejects a role menu whose current option is above Superior", async () => {
    const harness = createHarness();
    configureRoleMenuHarness(harness);
    harness.botMember.roles.highest.comparePositionTo.mockReturnValue(0);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("highest role must be above"),
      }),
    );
  });

  it("marks a new role-menu post stale when panel persistence fails", async () => {
    const harness = createHarness();
    const { upsertRoleMenuPost, setRoleMenuPostState } =
      configureRoleMenuHarness(harness);
    harness.storage.upsertPostedPanel.mockImplementationOnce(() => {
      throw new Error("synthetic panel persistence failure");
    });

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    const roleBinding = upsertRoleMenuPost.mock.calls[0]![0];
    expect(setRoleMenuPostState).toHaveBeenCalledWith(
      roleBinding.postId,
      "stale",
      null,
    );
    expect(harness.postedDelete).toHaveBeenCalledOnce();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("rolled back safely"),
      }),
    );
  });

  it("refreshes the tracked bot-authored message without posting a duplicate", async () => {
    const harness = createHarness(true);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.priorEdit).toHaveBeenCalledTimes(1);
    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.storage.upsertPostedPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: "existing_panel",
        messageId: MESSAGE_ID,
      }),
    );
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Refreshed"),
      }),
    );
  });

  it("does not orphan a new panel when Discord cannot verify the tracked message", async () => {
    const harness = createHarness(true);
    harness.channel.messages.fetch.mockRejectedValueOnce(
      new Error("synthetic Discord fetch outage"),
    );

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("could not verify"),
      }),
    );
  });

  it("serializes concurrent first-time posts into one tracked Discord message", async () => {
    const harness = createHarness();
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendImplementation =
      harness.channel.send.getMockImplementation() as () => Promise<unknown>;
    harness.channel.send.mockImplementationOnce(async () => {
      await sendGate;
      return sendImplementation();
    });
    const first = handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );
    const second = handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );
    await vi.waitFor(() =>
      expect(harness.channel.send).toHaveBeenCalledTimes(1),
    );
    releaseSend();

    await Promise.all([first, second]);

    expect(harness.channel.send).toHaveBeenCalledTimes(1);
    expect(harness.sentEdit).toHaveBeenCalledTimes(1);
    expect(harness.storage.upsertPostedPanel).toHaveBeenCalledTimes(2);
  });

  it("serializes onboarding and generic verification-panel handlers", async () => {
    const harness = createHarness();
    configureVerificationHarness(harness);
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendImplementation =
      harness.channel.send.getMockImplementation() as () => Promise<unknown>;
    harness.channel.send.mockImplementationOnce(async () => {
      await sendGate;
      return sendImplementation();
    });
    const onboardingInteraction = {
      ...harness.interaction,
      id: "onboarding_panel_interaction",
      editReply: vi.fn(async () => undefined),
      options: {
        getSubcommand: vi.fn(() => "panel"),
        getChannel: vi.fn(() => harness.channel),
        getBoolean: vi.fn(() => false),
      },
    };
    const genericInteraction = {
      ...harness.interaction,
      id: "generic_panel_interaction",
      editReply: vi.fn(async () => undefined),
      options: {
        getSubcommand: vi.fn(() => "post"),
        getString: vi.fn((name: string) =>
          name === "preset" ? "verification" : null,
        ),
        getChannel: vi.fn(() => harness.channel),
        getBoolean: vi.fn(() => false),
      },
    };

    const onboarding = handleOnboardingCommand(
      onboardingInteraction as never,
      harness.runtime,
      harness.actor as never,
    );
    await vi.waitFor(() =>
      expect(harness.channel.send).toHaveBeenCalledTimes(1),
    );
    const generic = handlePresetPanelCommand(
      genericInteraction as never,
      harness.runtime,
      harness.actor as never,
    );
    await Promise.resolve();
    expect(harness.channel.send).toHaveBeenCalledTimes(1);
    releaseSend();

    await Promise.all([onboarding, generic]);

    expect(harness.channel.send).toHaveBeenCalledTimes(1);
    expect(harness.storage.upsertPostedPanel).toHaveBeenCalledTimes(1);
    expect(genericInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("already tracked"),
      }),
    );
  });

  it("restores a tracked message when runtime changes during its edit", async () => {
    const harness = createHarness(true);
    const isCurrent = harness.runtime.isCurrent as ReturnType<typeof vi.fn>;
    isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.priorEdit).toHaveBeenCalledTimes(2);
    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("No panel change was retained"),
      }),
    );
  });

  it("reports an untracked message when stale-post cleanup fails", async () => {
    const harness = createHarness();
    harness.postedDelete.mockRejectedValueOnce(
      new Error("synthetic Discord deletion failure"),
    );
    const isCurrent = harness.runtime.isCurrent as ReturnType<typeof vi.fn>;
    isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.storage.upsertPostedPanel).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(`\`${MESSAGE_ID}\``),
      }),
    );
  });

  it("refuses a ticket launcher until ticket configuration is enabled", async () => {
    const harness = createHarness();
    harness.interaction.options.getString = vi.fn((name: string) =>
      name === "preset" ? "tickets" : null,
    );

    await handlePresetPanelCommand(
      harness.interaction as never,
      harness.runtime,
      harness.actor as never,
    );

    expect(harness.channel.send).not.toHaveBeenCalled();
    expect(harness.interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("/ticket department create"),
      }),
    );
  });
});
