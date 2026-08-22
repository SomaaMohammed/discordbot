import { ChannelType, Collection, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import type { GuildRuntime } from "../src/runtime.js";
import {
  handlePresetPanelCommand,
  panelCapabilityForOperation,
} from "../src/discord/preset-panels.js";

const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "223456789012345678";
const MESSAGE_ID = "323456789012345678";
const BOT_ID = "423456789012345678";
const ACTOR_ID = "523456789012345678";
const REPORT_CHANNEL_ID = "623456789012345678";
const APPEAL_CHANNEL_ID = "723456789012345678";
const REPORT_ROLE_ID = "823456789012345678";
const APPEAL_ROLE_ID = "923456789012345678";

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
  };
  const priorEdit = vi.fn(async () => undefined);
  const prior = {
    id: MESSAGE_ID,
    author: { id: BOT_ID },
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
    permissionsFor: vi.fn(() => permissions),
    messages: {
      fetch: vi.fn(async (id: string) => messages.get(id) ?? null),
    },
    send: vi.fn(async () => {
      const message = {
        id: MESSAGE_ID,
        author: { id: BOT_ID },
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
    channels: { cache: new Map([[CHANNEL_ID, channel]]) },
    roles: { cache: new Map() },
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
    guild,
    guildId: GUILD_ID,
    client: { user: { id: BOT_ID } },
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
  const actor = { id: ACTOR_ID, guild };
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
  it("requires moderation.configure only for posting the safety preset", () => {
    expect(panelCapabilityForOperation("post", "safety")).toBe(
      "moderation.configure",
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
