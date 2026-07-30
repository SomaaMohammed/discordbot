import { ChannelType, PermissionFlagsBits } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultGuildSettings } from "../src/guild-settings.js";
import type { BotRuntime, GuildRuntime } from "../src/runtime.js";
import { BotStorage, type GuildStorage } from "../src/storage/db.js";
import { createOpaqueStorageId } from "../src/storage/operational-repository.js";
import { handleChatInputCommand } from "../src/discord/commands.js";
import { buildTicketCommandDefinition } from "../src/discord/ticket-command.js";
import { handleTicketCommand } from "../src/discord/ticket-commands-handler.js";
import {
  handleTicketButton,
  handleTicketModal,
} from "../src/discord/ticket-interactions.js";
import { ticketChannelRecoveryMarker } from "../src/discord/ticket-permissions.js";

const GUILD_ID = "111111111111111111";
const OWNER_ID = "222222222222222222";
const BOT_ID = "333333333333333333";
const OPENER_ID = "444444444444444444";
const SUPPORT_ROLE_ID = "555555555555555555";
const STAFF_A_ID = "666666666666666666";
const STAFF_B_ID = "777777777777777777";
const OUTSIDER_ID = "707070707070707070";
const CATEGORY_ID = "888888888888888888";
const LOG_CHANNEL_ID = "999999999999999999";
const PANEL_CHANNEL_ID = "121212121212121212";
const PANEL_MESSAGE_ID = "131313131313131313";
const TICKET_CHANNEL_ID = "141414141414141414";
const CONTROL_MESSAGE_ID = "151515151515151515";
const RECOVERY_CHANNEL_A = "181818181818181818";
const RECOVERY_CHANNEL_B = "191919191919191919";
const RECOVERY_CONTROL_A = "202020202020202020";
const RECOVERY_CONTROL_B = "212121212121212121";
const NEW_SUPPORT_ROLE_ID = "232323232323232323";

const openStorages: BotStorage[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) storage.close();
});

interface Harness {
  rootStorage: BotStorage;
  storage: GuildStorage;
  runtime: GuildRuntime;
  guild: Record<string, any>;
  panelId: string;
  category: Record<string, any>;
  logChannel: Record<string, any>;
  panelChannel: Record<string, any>;
  ticketChannel: Record<string, any>;
  supportRole: Record<string, any>;
  botMember: Record<string, any>;
  opener: Record<string, any>;
  staffA: Record<string, any>;
  staffB: Record<string, any>;
  outsider: Record<string, any>;
  createChannel: ReturnType<typeof vi.fn>;
  controlDelete: ReturnType<typeof vi.fn>;
  ticketControlEdit: ReturnType<typeof vi.fn>;
  dmSend: ReturnType<typeof vi.fn>;
}

function createHarness(
  options: {
    logFailure?: boolean;
    ticketDeleteFailure?: boolean;
    categoryDeniedPermission?: bigint;
    globalDeniedPermission?: bigint;
  } = {},
): Harness {
  const rootStorage = new BotStorage({ dbFile: ":memory:" });
  rootStorage.initStorage();
  rootStorage.ensureGuild(GUILD_ID, "Test Server");
  openStorages.push(rootStorage);
  const storage = rootStorage.forGuild(GUILD_ID);
  const settings = createDefaultGuildSettings();
  settings.enabled = true;
  settings.reviewRequired = false;

  const guild: Record<string, any> = {
    id: GUILD_ID,
    ownerId: OWNER_ID,
    name: "Test Server",
  };
  const permissionSet = (denied?: bigint) => ({
    has: vi.fn((permission: bigint) => permission !== denied),
  });
  const globalPermissionSet = permissionSet(options.globalDeniedPermission);
  const categoryPermissionSet = permissionSet(options.categoryDeniedPermission);
  const channelPermissionSet = permissionSet();
  const supportRole = {
    id: SUPPORT_ROLE_ID,
    name: "Support",
    guild,
    managed: false,
  };
  const makeMember = (id: string, support: boolean, administrator = false) => ({
    id,
    guild,
    user: { id, bot: false, tag: `user-${id.slice(-4)}` },
    permissions: {
      has: vi.fn((permission: bigint) =>
        administrator
          ? permission === PermissionFlagsBits.Administrator
          : false,
      ),
    },
    roles: {
      cache: new Map(support ? [[SUPPORT_ROLE_ID, supportRole]] : []),
      highest: { comparePositionTo: vi.fn(() => 1) },
    },
  });
  const opener = makeMember(OPENER_ID, false);
  const staffA = makeMember(STAFF_A_ID, true);
  const staffB = makeMember(STAFF_B_ID, true);
  const outsider = makeMember(OUTSIDER_ID, false);
  const botMember = {
    id: BOT_ID,
    guild,
    user: { id: BOT_ID, bot: true, tag: "Superior" },
    permissions: globalPermissionSet,
    roles: {
      cache: new Map(),
      highest: { comparePositionTo: vi.fn(() => 1) },
    },
  };
  const category = {
    id: CATEGORY_ID,
    name: "Tickets",
    guild,
    type: ChannelType.GuildCategory,
    permissionsFor: vi.fn(() => categoryPermissionSet),
  };
  const logSend = options.logFailure
    ? vi.fn(async () => {
        throw new Error("synthetic log failure");
      })
    : vi.fn(async () => ({ id: "161616161616161616" }));
  const logChannel = {
    id: LOG_CHANNEL_ID,
    name: "ticket-log",
    guild,
    type: ChannelType.GuildText,
    isDMBased: vi.fn(() => false),
    permissionsFor: vi.fn(() => channelPermissionSet),
    send: logSend,
  };
  const panelMessage = {
    id: PANEL_MESSAGE_ID,
    author: { id: BOT_ID },
  };
  const panelChannel = {
    id: PANEL_CHANNEL_ID,
    name: "help-desk",
    guild,
    type: ChannelType.GuildText,
    isDMBased: vi.fn(() => false),
    permissionsFor: vi.fn(() => channelPermissionSet),
    messages: {
      fetch: vi.fn(async (id: string) =>
        id === PANEL_MESSAGE_ID ? panelMessage : null,
      ),
    },
  };
  const controlDelete = vi.fn(async () => undefined);
  const ticketSend = vi.fn(async () => ({
    id: CONTROL_MESSAGE_ID,
    author: { id: BOT_ID },
    delete: controlDelete,
  }));
  const ticketChannel: Record<string, any> = {
    id: TICKET_CHANNEL_ID,
    name: "ticket-1-help",
    guild,
    type: ChannelType.GuildText,
    isDMBased: vi.fn(() => false),
    permissionsFor: vi.fn(() => channelPermissionSet),
    send: ticketSend,
    delete: options.ticketDeleteFailure
      ? vi.fn(async () => {
          throw new Error("synthetic channel deletion failure");
        })
      : vi.fn(async () => undefined),
  };
  const ticketControlMessage: Record<string, any> = {
    id: CONTROL_MESSAGE_ID,
    author: { id: BOT_ID },
    embeds: [],
    components: [],
    delete: controlDelete,
  };
  const ticketControlEdit = vi.fn(async () => ticketControlMessage);
  ticketControlMessage.edit = ticketControlEdit;
  ticketChannel.messages = {
    fetch: vi.fn(async (input: unknown) =>
      typeof input === "string"
        ? input === CONTROL_MESSAGE_ID
          ? ticketControlMessage
          : null
        : new Map(),
    ),
  };
  ticketChannel.edit = vi.fn(async () => ticketChannel);
  const channels = new Map<string, Record<string, any>>([
    [CATEGORY_ID, category],
    [LOG_CHANNEL_ID, logChannel],
    [PANEL_CHANNEL_ID, panelChannel],
    [TICKET_CHANNEL_ID, ticketChannel],
  ]);
  const createChannel = vi.fn(async () => ticketChannel);
  guild.channels = {
    cache: channels,
    fetch: vi.fn(async (id: string) => channels.get(id) ?? null),
    create: createChannel,
  };
  guild.roles = {
    everyone: { id: GUILD_ID },
    cache: new Map([[SUPPORT_ROLE_ID, supportRole]]),
    fetch: vi.fn(async (id: string) =>
      id === SUPPORT_ROLE_ID ? supportRole : null,
    ),
  };
  const members = new Map([
    [OPENER_ID, opener],
    [STAFF_A_ID, staffA],
    [STAFF_B_ID, staffB],
    [OUTSIDER_ID, outsider],
    [BOT_ID, botMember],
  ]);
  guild.members = {
    me: botMember,
    fetchMe: vi.fn(async () => botMember),
    fetch: vi.fn(async (id: string) => members.get(id) ?? null),
  };

  storage.upsertTicketConfiguration({
    categoryId: CATEGORY_ID,
    logChannelId: LOG_CHANNEL_ID,
    supportRoleId: SUPPORT_ROLE_ID,
  });
  const panelId = createOpaqueStorageId();
  storage.createPostedPanel({
    panelId,
    preset: "tickets",
    channelId: PANEL_CHANNEL_ID,
    messageId: PANEL_MESSAGE_ID,
  });
  const runtime = {
    guildId: GUILD_ID,
    botVersion: "5.2.0",
    storage,
    settings,
    generation: 0,
    isCurrent: vi.fn(() => true),
    invalidate: vi.fn(),
  } as unknown as GuildRuntime;
  const dmSend = vi.fn(async () => undefined);
  return {
    rootStorage,
    storage,
    runtime,
    guild,
    panelId,
    category,
    logChannel,
    panelChannel,
    ticketChannel,
    supportRole,
    botMember,
    opener,
    staffA,
    staffB,
    outsider,
    createChannel,
    controlDelete,
    ticketControlEdit,
    dmSend,
  };
}

function interactionClient(harness: Harness) {
  return {
    user: { id: BOT_ID },
    users: {
      fetch: vi.fn(async (id: string) =>
        id === OPENER_ID ? { id, bot: false, send: harness.dmSend } : null,
      ),
    },
  };
}

function createModalInteraction(
  harness: Harness,
  customId: string,
  userId: string,
  channelId: string,
  fields: Record<string, string>,
) {
  const interaction: Record<string, any> = {
    customId,
    guild: harness.guild,
    guildId: GUILD_ID,
    channelId,
    user: { id: userId },
    client: interactionClient(harness),
    fields: {
      getTextInputValue: vi.fn((name: string) => fields[name] ?? ""),
    },
    deferred: false,
    replied: false,
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  interaction.deferReply = vi.fn(async () => {
    interaction.deferred = true;
  });
  return interaction;
}

function createActiveTicket(
  harness: Harness,
): ReturnType<GuildStorage["getTicketById"]> {
  const reserved = harness.storage.reserveTicketCreation({
    openerId: OPENER_ID,
    subject: "Account access",
    description: "I need help restoring access.",
  });
  if (reserved.status !== "created") throw new Error("expected reservation");
  const activated = harness.storage.activateTicketCreation(
    reserved.ticket.ticketId,
    { channelId: TICKET_CHANNEL_ID, controlMessageId: CONTROL_MESSAGE_ID },
  );
  if (activated.status !== "activated") throw new Error("expected activation");
  return activated.ticket;
}

function createTicketButtonInteraction(
  harness: Harness,
  customId: string,
  userId: string,
  overrides: { channelId?: string; messageId?: string } = {},
) {
  const message = {
    id: overrides.messageId ?? CONTROL_MESSAGE_ID,
    author: { id: BOT_ID },
    edit: vi.fn(async () => undefined),
  };
  const interaction: Record<string, any> = {
    customId,
    guild: harness.guild,
    guildId: GUILD_ID,
    channelId: overrides.channelId ?? TICKET_CHANNEL_ID,
    user: { id: userId },
    client: interactionClient(harness),
    message,
    deferred: false,
    replied: false,
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    showModal: vi.fn(async () => undefined),
  };
  interaction.deferReply = vi.fn(async () => {
    interaction.deferred = true;
  });
  return interaction;
}

function createRecoveryInteraction(harness: Harness, ticketNumber: number) {
  return {
    guild: harness.guild,
    guildId: GUILD_ID,
    options: {
      getSubcommand: vi.fn(() => "recover"),
      getInteger: vi.fn(() => ticketNumber),
    },
    deferred: false,
    replied: false,
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
}

function createRecoveredChannel(
  harness: Harness,
  channelId: string,
  controlMessageId: string,
) {
  const controlDelete = vi.fn(async () => undefined);
  const channel: Record<string, any> = {
    id: channelId,
    name: `ticket-recovery-${channelId.slice(-4)}`,
    guild: harness.guild,
    type: ChannelType.GuildText,
    send: vi.fn(async () => ({
      id: controlMessageId,
      author: { id: BOT_ID },
      delete: controlDelete,
    })),
    delete: vi.fn(async () => undefined),
  };
  channel.edit = vi.fn(async () => channel);
  return { channel, controlDelete };
}

describe("ticket command definition", () => {
  it("registers a bounded guild-only setup, status, panel, disable, and recovery surface", () => {
    const command = buildTicketCommandDefinition().toJSON();
    const options = command.options as
      | Array<{
          name: string;
          options?: Array<{
            name: string;
            min_value?: number;
            max_value?: number;
          }>;
        }>
      | undefined;
    expect(command.dm_permission).toBe(false);
    expect(options?.map(({ name }) => name)).toEqual([
      "setup",
      "status",
      "panel",
      "disable",
      "recover",
    ]);
    expect(
      options?.every((option) => (option.options?.length ?? 0) <= 25),
    ).toBe(true);
    expect(
      options
        ?.find(({ name }) => name === "recover")
        ?.options?.find(({ name }) => name === "ticket_number"),
    ).toMatchObject({ min_value: 1, max_value: 2_147_483_647 });
  });
});

describe("ticket interaction workflow", () => {
  it("refuses category or support-role rotation while tickets are active", async () => {
    const harness = createHarness();
    createActiveTicket(harness);
    const replacementRole = {
      id: NEW_SUPPORT_ROLE_ID,
      name: "Escalations",
      guild: harness.guild,
      managed: false,
    };
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      options: {
        getSubcommand: vi.fn(() => "setup"),
        getChannel: vi.fn((name: string) =>
          name === "category" ? harness.category : harness.logChannel,
        ),
        getRole: vi.fn(() => replacementRole),
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.storage.getTicketConfiguration()).toMatchObject({
      supportRoleId: SUPPORT_ROLE_ID,
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("active") }),
    );
  });

  it("allows replacement of a confirmed-missing support role with active tickets", async () => {
    const harness = createHarness();
    createActiveTicket(harness);
    const replacementRole = {
      id: NEW_SUPPORT_ROLE_ID,
      name: "Escalations",
      guild: harness.guild,
      managed: false,
    };
    harness.guild.roles.cache.delete(SUPPORT_ROLE_ID);
    harness.guild.roles.cache.set(NEW_SUPPORT_ROLE_ID, replacementRole);
    harness.guild.roles.fetch.mockImplementation(async (id: string) =>
      id === NEW_SUPPORT_ROLE_ID ? replacementRole : null,
    );
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      options: {
        getSubcommand: vi.fn(() => "setup"),
        getChannel: vi.fn((name: string) =>
          name === "category" ? harness.category : harness.logChannel,
        ),
        getRole: vi.fn(() => replacementRole),
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.storage.getTicketConfiguration()).toMatchObject({
      supportRoleId: NEW_SUPPORT_ROLE_ID,
    });
    expect(harness.runtime.invalidate).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("recover") }),
    );
  });

  it("does not authorize active-role replacement after a transient lookup failure", async () => {
    const harness = createHarness();
    createActiveTicket(harness);
    const replacementRole = {
      id: NEW_SUPPORT_ROLE_ID,
      name: "Escalations",
      guild: harness.guild,
      managed: false,
    };
    harness.guild.roles.fetch.mockRejectedValueOnce(
      new Error("synthetic Discord role lookup outage"),
    );
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      options: {
        getSubcommand: vi.fn(() => "setup"),
        getChannel: vi.fn((name: string) =>
          name === "category" ? harness.category : harness.logChannel,
        ),
        getRole: vi.fn(() => replacementRole),
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.storage.getTicketConfiguration()).toMatchObject({
      supportRoleId: SUPPORT_ROLE_ID,
    });
    expect(harness.runtime.invalidate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("could not verify"),
      }),
    );
  });

  it("allows a log-channel-only update while tickets are active", async () => {
    const harness = createHarness();
    createActiveTicket(harness);
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      options: {
        getSubcommand: vi.fn(() => "setup"),
        getChannel: vi.fn((name: string) =>
          name === "category" ? harness.category : harness.panelChannel,
        ),
        getRole: vi.fn(() => harness.supportRole),
      },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.storage.getTicketConfiguration()).toMatchObject({
      categoryId: CATEGORY_ID,
      supportRoleId: SUPPORT_ROLE_ID,
      logChannelId: PANEL_CHANNEL_ID,
    });
    expect(harness.runtime.invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not disable a newer ticket configuration from a stale runtime", async () => {
    const harness = createHarness();
    (harness.runtime.isCurrent as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );
    const interaction: Record<string, any> = {
      guild: harness.guild,
      guildId: GUILD_ID,
      options: { getSubcommand: vi.fn(() => "disable") },
      deferred: false,
      replied: false,
      reply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.storage.getTicketConfiguration()).toMatchObject({
      enabled: true,
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("creates a persisted private ticket and welcome controls from a valid modal", async () => {
    const harness = createHarness();
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:open-modal:${harness.panelId}`,
      OPENER_ID,
      PANEL_CHANNEL_ID,
      { subject: " Login issue ", description: " I cannot sign in. " },
    );

    await handleTicketModal(interaction as never, harness.runtime);

    const ticket = harness.storage.getTicketByOpener(OPENER_ID);
    expect(ticket).toMatchObject({
      state: "open",
      channelId: TICKET_CHANNEL_ID,
      controlMessageId: CONTROL_MESSAGE_ID,
      subject: "Login issue",
      description: "I cannot sign in.",
    });
    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ChannelType.GuildText,
        parent: CATEGORY_ID,
        permissionOverwrites: expect.arrayContaining([
          expect.objectContaining({ id: GUILD_ID }),
          expect.objectContaining({ id: OPENER_ID }),
          expect.objectContaining({ id: SUPPORT_ROLE_ID }),
          expect.objectContaining({ id: BOT_ID }),
        ]),
      }),
    );
    expect(harness.ticketChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
        allowedMentions: { parse: [] },
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("is ready") }),
    );
  });

  it("prevents a repeated submission while the first channel is still being created", async () => {
    const harness = createHarness();
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    harness.createChannel.mockImplementationOnce(async () => {
      await creationGate;
      return harness.ticketChannel;
    });
    const first = createModalInteraction(
      harness,
      `superior:ticket:open-modal:${harness.panelId}`,
      OPENER_ID,
      PANEL_CHANNEL_ID,
      { subject: "First", description: "First request" },
    );
    const second = createModalInteraction(
      harness,
      `superior:ticket:open-modal:${harness.panelId}`,
      OPENER_ID,
      PANEL_CHANNEL_ID,
      { subject: "Second", description: "Second request" },
    );

    const firstRun = handleTicketModal(first as never, harness.runtime);
    await vi.waitFor(() =>
      expect(harness.createChannel).toHaveBeenCalledTimes(1),
    );
    await handleTicketModal(second as never, harness.runtime);
    releaseCreation();
    await firstRun;

    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.storage.listTickets()).toHaveLength(1);
    expect(second.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("already") }),
    );
  });

  it("does not roll back a durable ticket when only the acknowledgement fails", async () => {
    const harness = createHarness();
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:open-modal:${harness.panelId}`,
      OPENER_ID,
      PANEL_CHANNEL_ID,
      { subject: "Login issue", description: "I cannot sign in." },
    );
    interaction.editReply.mockRejectedValueOnce(
      new Error("synthetic acknowledgement failure"),
    );

    await expect(
      handleTicketModal(interaction as never, harness.runtime),
    ).rejects.toThrow("acknowledgement failure");

    expect(harness.storage.getTicketByOpener(OPENER_ID)).toMatchObject({
      state: "open",
      channelId: TICKET_CHANNEL_ID,
      controlMessageId: CONTROL_MESSAGE_ID,
    });
    expect(harness.ticketChannel.delete).not.toHaveBeenCalled();
  });

  it("allows exactly one concurrent support claim and permits release", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    const first = createTicketButtonInteraction(
      harness,
      `superior:ticket:claim:${ticket.ticketId}`,
      STAFF_A_ID,
    );
    const second = createTicketButtonInteraction(
      harness,
      `superior:ticket:claim:${ticket.ticketId}`,
      STAFF_B_ID,
    );

    await Promise.all([
      handleTicketButton(first as never, harness.runtime),
      handleTicketButton(second as never, harness.runtime),
    ]);

    const claimed = harness.storage.getTicketById(ticket.ticketId)!;
    expect([STAFF_A_ID, STAFF_B_ID]).toContain(claimed.claimedBy);
    expect(
      harness.storage
        .listTicketEvents(ticket.ticketId)
        .filter(({ type }) => type === "claimed"),
    ).toHaveLength(1);

    const release = createTicketButtonInteraction(
      harness,
      `superior:ticket:release:${ticket.ticketId}`,
      STAFF_A_ID,
    );
    await handleTicketButton(release as never, harness.runtime);
    expect(
      harness.storage.getTicketById(ticket.ticketId)?.claimedBy,
    ).toBeNull();
  });

  it("rejects an old claim control that is rebound during staff verification", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.guild.roles.fetch.mockImplementationOnce(async () => {
      const rebound = harness.storage.rebindTicket(ticket.ticketId, {
        channelId: TICKET_CHANNEL_ID,
        controlMessageId: RECOVERY_CONTROL_A,
        expectedChannelId: TICKET_CHANNEL_ID,
        expectedControlMessageId: CONTROL_MESSAGE_ID,
        expectedState: ticket.state,
        expectedUpdatedAt: ticket.updatedAt,
      });
      expect(rebound.status).toBe("rebound");
      return harness.supportRole;
    });
    const interaction = createTicketButtonInteraction(
      harness,
      `superior:ticket:claim:${ticket.ticketId}`,
      STAFF_A_ID,
    );

    await handleTicketButton(interaction as never, harness.runtime);

    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      claimedBy: null,
      controlMessageId: RECOVERY_CONTROL_A,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("rejects ticket management by a member outside the staff policy", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    const interaction = createTicketButtonInteraction(
      harness,
      `superior:ticket:claim:${ticket.ticketId}`,
      OUTSIDER_ID,
    );

    await handleTicketButton(interaction as never, harness.runtime);

    expect(
      harness.storage.getTicketById(ticket.ticketId)?.claimedBy,
    ).toBeNull();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("support role"),
      }),
    );
  });

  it("allows the opener to inspect their ticket and rejects another member", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    const outsider = createTicketButtonInteraction(
      harness,
      `superior:ticket:info:${ticket.ticketId}`,
      OUTSIDER_ID,
    );
    const opener = createTicketButtonInteraction(
      harness,
      `superior:ticket:info:${ticket.ticketId}`,
      OPENER_ID,
    );

    await handleTicketButton(outsider as never, harness.runtime);
    await handleTicketButton(opener as never, harness.runtime);

    expect(outsider.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("opener") }),
    );
    expect(opener.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it("does not disclose stale ticket info after runtime invalidation", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    let current = true;
    (harness.runtime.isCurrent as ReturnType<typeof vi.fn>).mockImplementation(
      () => current,
    );
    harness.guild.members.fetch.mockImplementation(async (id: string) => {
      if (id === OPENER_ID) {
        current = false;
        return harness.opener;
      }
      return null;
    });
    const interaction = createTicketButtonInteraction(
      harness,
      `superior:ticket:info:${ticket.ticketId}`,
      OPENER_ID,
    );

    await handleTicketButton(interaction as never, harness.runtime);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
    expect(interaction.editReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it("does not open a close modal after staff verification goes stale", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    let current = true;
    (harness.runtime.isCurrent as ReturnType<typeof vi.fn>).mockImplementation(
      () => current,
    );
    harness.guild.roles.fetch.mockImplementation(async (id: string) => {
      if (id === SUPPORT_ROLE_ID) {
        current = false;
        return harness.supportRole;
      }
      return null;
    });
    const interaction = createTicketButtonInteraction(
      harness,
      `superior:ticket:close:${ticket.ticketId}`,
      STAFF_A_ID,
    );

    await handleTicketButton(interaction as never, harness.runtime);

    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("changed") }),
    );
  });

  it("rejects a stale or cross-channel control before changing ticket state", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    const interaction = createTicketButtonInteraction(
      harness,
      `superior:ticket:claim:${ticket.ticketId}`,
      STAFF_A_ID,
      { channelId: PANEL_CHANNEL_ID },
    );

    await handleTicketButton(interaction as never, harness.runtime);

    expect(
      harness.storage.getTicketById(ticket.ticketId)?.claimedBy,
    ).toBeNull();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("outdated") }),
    );
  });

  it("rejects a cross-guild component before resolving its ticket", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    const interaction = createTicketButtonInteraction(
      harness,
      `superior:ticket:claim:${ticket.ticketId}`,
      STAFF_A_ID,
    );
    interaction.guildId = "181818181818181818";

    await handleTicketButton(interaction as never, harness.runtime);

    expect(
      harness.storage.getTicketById(ticket.ticketId)?.claimedBy,
    ).toBeNull();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("outdated") }),
    );
  });

  it("refuses ticket creation when a configured Discord resource disappeared", async () => {
    const harness = createHarness();
    harness.guild.roles.fetch.mockResolvedValue(null);
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:open-modal:${harness.panelId}`,
      OPENER_ID,
      PANEL_CHANNEL_ID,
      { subject: "Login issue", description: "I cannot sign in." },
    );

    await handleTicketModal(interaction as never, harness.runtime);

    expect(harness.storage.listTickets()).toHaveLength(0);
    expect(harness.createChannel).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("attention"),
      }),
    );
  });

  it.each([
    {
      label: "Attach Files in the ticket category",
      options: { categoryDeniedPermission: PermissionFlagsBits.AttachFiles },
      expected: "Attach Files",
    },
    {
      label: "global Manage Roles",
      options: { globalDeniedPermission: PermissionFlagsBits.ManageRoles },
      expected: "Manage Roles",
    },
  ])(
    "refuses ticket creation without $label",
    async ({ options, expected }) => {
      const harness = createHarness(options);
      const interaction = createModalInteraction(
        harness,
        `superior:ticket:open-modal:${harness.panelId}`,
        OPENER_ID,
        PANEL_CHANNEL_ID,
        { subject: "Login issue", description: "I cannot sign in." },
      );

      await handleTicketModal(interaction as never, harness.runtime);

      expect(harness.storage.listTickets()).toHaveLength(0);
      expect(harness.createChannel).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining(expected) }),
      );
    },
  );

  it("keeps a failed cleanup bound for restart-safe administrative recovery", async () => {
    const harness = createHarness({ ticketDeleteFailure: true });
    const isCurrent = harness.runtime.isCurrent as ReturnType<typeof vi.fn>;
    isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const first = createModalInteraction(
      harness,
      `superior:ticket:open-modal:${harness.panelId}`,
      OPENER_ID,
      PANEL_CHANNEL_ID,
      { subject: "Interrupted", description: "Preserve failed cleanup." },
    );

    await handleTicketModal(first as never, harness.runtime);

    expect(harness.ticketChannel.delete).toHaveBeenCalledTimes(1);
    expect(harness.storage.getTicketByOpener(OPENER_ID)).toMatchObject({
      state: "creating",
      channelId: TICKET_CHANNEL_ID,
      controlMessageId: null,
    });
    expect(first.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("recover") }),
    );

    const repeated = createModalInteraction(
      harness,
      `superior:ticket:open-modal:${harness.panelId}`,
      OPENER_ID,
      PANEL_CHANNEL_ID,
      { subject: "Repeated", description: "Do not duplicate the channel." },
    );
    await handleTicketModal(repeated as never, harness.runtime);

    expect(harness.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.storage.listTickets()).toHaveLength(1);
    expect(repeated.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("already") }),
    );
  });

  it("rolls a failed transcript log back to open and preserves the channel", async () => {
    const harness = createHarness({ logFailure: true });
    const ticket = createActiveTicket(harness)!;
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:close-modal:${ticket.ticketId}`,
      STAFF_A_ID,
      TICKET_CHANNEL_ID,
      { reason: "Resolved after review" },
    );

    await handleTicketModal(interaction as never, harness.runtime);

    expect(harness.storage.getTicketById(ticket.ticketId)?.state).toBe("open");
    expect(harness.logChannel.send).toHaveBeenCalledTimes(1);
    expect(harness.ticketChannel.delete).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("preserved"),
      }),
    );
  });

  it("does not checkpoint or finalize when runtime changes during log delivery", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    let current = true;
    (harness.runtime.isCurrent as ReturnType<typeof vi.fn>).mockImplementation(
      () => current,
    );
    harness.logChannel.send.mockImplementationOnce(async () => {
      current = false;
      return { id: "262626262626262626" };
    });
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:close-modal:${ticket.ticketId}`,
      STAFF_A_ID,
      TICKET_CHANNEL_ID,
      { reason: "Resolved during reconfiguration" },
    );

    await handleTicketModal(interaction as never, harness.runtime);

    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      state: "closing",
      closeLogMessageId: null,
    });
    expect(harness.ticketChannel.delete).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("server changed"),
      }),
    );
  });

  it("does not finalize a checkpointed close when runtime changes during DM", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    let current = true;
    (harness.runtime.isCurrent as ReturnType<typeof vi.fn>).mockImplementation(
      () => current,
    );
    harness.dmSend.mockImplementationOnce(async () => {
      current = false;
    });
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:close-modal:${ticket.ticketId}`,
      STAFF_A_ID,
      TICKET_CHANNEL_ID,
      { reason: "Resolved before a concurrent import" },
    );

    await handleTicketModal(interaction as never, harness.runtime);

    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      state: "closing",
      closeLogMessageId: "161616161616161616",
    });
    expect(harness.ticketChannel.delete).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("server changed"),
      }),
    );
  });

  it("logs, persists, best-effort DMs, and only then deletes on close", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:close-modal:${ticket.ticketId}`,
      STAFF_A_ID,
      TICKET_CHANNEL_ID,
      { reason: "Resolved after review" },
    );

    await handleTicketModal(interaction as never, harness.runtime);

    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      state: "closed",
      closedBy: STAFF_A_ID,
      closeReason: "Resolved after review",
      closeLogMessageId: "161616161616161616",
      closeLoggedAt: expect.any(String),
    });
    expect(harness.logChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ attachment: expect.any(Buffer) })],
      }),
    );
    expect(harness.dmSend).toHaveBeenCalledTimes(1);
    expect(harness.ticketChannel.delete).toHaveBeenCalledTimes(1);

    const repeated = createModalInteraction(
      harness,
      `superior:ticket:close-modal:${ticket.ticketId}`,
      STAFF_A_ID,
      TICKET_CHANNEL_ID,
      { reason: "Repeated" },
    );
    await handleTicketModal(repeated as never, harness.runtime);
    expect(harness.logChannel.send).toHaveBeenCalledTimes(1);
    expect(repeated.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("already closed"),
      }),
    );
  });

  it("finishes a checkpointed closing ticket without duplicating its log", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    expect(
      harness.storage.beginTicketClose(
        ticket.ticketId,
        STAFF_A_ID,
        "Resolved before restart",
      ).status,
    ).toBe("started");
    expect(
      harness.storage.markTicketLogDelivered(
        ticket.ticketId,
        "171717171717171717",
      ).status,
    ).toBe("logged");
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:close-modal:${ticket.ticketId}`,
      STAFF_A_ID,
      TICKET_CHANNEL_ID,
      { reason: "Resume after restart" },
    );

    await handleTicketModal(interaction as never, harness.runtime);

    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      state: "closed",
      closeLogMessageId: "171717171717171717",
    });
    expect(harness.logChannel.send).not.toHaveBeenCalled();
    expect(harness.dmSend).not.toHaveBeenCalled();
    expect(harness.ticketChannel.delete).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("already logged"),
      }),
    );
  });

  it("keeps a checkpointed close recoverable when channel lookup fails transiently", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.storage.beginTicketClose(
      ticket.ticketId,
      STAFF_A_ID,
      "Resolved before a Discord outage",
    );
    harness.storage.markTicketLogDelivered(
      ticket.ticketId,
      "242424242424242424",
    );
    harness.guild.channels.fetch.mockImplementation(async (id: string) => {
      if (id === TICKET_CHANNEL_ID) {
        throw new Error("synthetic Discord channel lookup outage");
      }
      return null;
    });
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:close-modal:${ticket.ticketId}`,
      STAFF_A_ID,
      TICKET_CHANNEL_ID,
      { reason: "Resume" },
    );

    await handleTicketModal(interaction as never, harness.runtime);

    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      state: "closing",
      closeLogMessageId: "242424242424242424",
    });
    expect(harness.ticketChannel.delete).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("could not verify"),
      }),
    );
  });

  it("preserves a logged ticket channel when runtime changes during its fetch", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.storage.beginTicketClose(
      ticket.ticketId,
      STAFF_A_ID,
      "Resolved before a concurrent import",
    );
    harness.storage.markTicketLogDelivered(
      ticket.ticketId,
      "242424242424242424",
    );
    let current = true;
    (harness.runtime.isCurrent as ReturnType<typeof vi.fn>).mockImplementation(
      () => current,
    );
    harness.guild.channels.fetch.mockImplementation(async (id: string) => {
      if (id === TICKET_CHANNEL_ID) {
        current = false;
        return harness.ticketChannel;
      }
      return null;
    });
    const interaction = createModalInteraction(
      harness,
      `superior:ticket:close-modal:${ticket.ticketId}`,
      STAFF_A_ID,
      TICKET_CHANNEL_ID,
      { reason: "Resume" },
    );

    await handleTicketModal(interaction as never, harness.runtime);

    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      state: "closing",
      closeLogMessageId: "242424242424242424",
    });
    expect(harness.ticketChannel.delete).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("preserved"),
      }),
    );
  });

  it("recovers a missing channel as staff-only when the opener left", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.guild.channels.fetch.mockImplementation(async (id: string) => {
      if (id === CATEGORY_ID) return harness.category;
      if (id === LOG_CHANNEL_ID) return harness.logChannel;
      if (id === PANEL_CHANNEL_ID) return harness.panelChannel;
      return null;
    });
    harness.guild.members.fetch.mockImplementation(async (id: string) => {
      if (id === STAFF_A_ID) return harness.staffA;
      if (id === BOT_ID) return harness.botMember;
      return null;
    });
    const interaction = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionOverwrites: expect.not.arrayContaining([
          expect.objectContaining({ id: OPENER_ID }),
        ]),
      }),
    );
    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      state: "open",
      channelId: TICKET_CHANNEL_ID,
      controlMessageId: CONTROL_MESSAGE_ID,
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("staff-only"),
      }),
    );
  });

  it("discovers a just-created channel after a restart interrupted persistence", async () => {
    const harness = createHarness();
    const reservation = harness.storage.reserveTicketCreation({
      openerId: OPENER_ID,
      subject: "Interrupted persistence",
      description: "The process stopped after Discord created the channel.",
    });
    expect(reservation.status).toBe("created");
    harness.ticketChannel.topic = `Superior interrupted ticket · ${ticketChannelRecoveryMarker(reservation.ticket.ticketId)}`;
    const interaction = createRecoveryInteraction(
      harness,
      reservation.ticket.ticketNumber,
    );

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.createChannel).not.toHaveBeenCalled();
    expect(harness.ticketChannel.edit).toHaveBeenCalledTimes(1);
    expect(
      harness.storage.getTicketById(reservation.ticket.ticketId),
    ).toMatchObject({
      state: "open",
      channelId: TICKET_CHANNEL_ID,
      controlMessageId: CONTROL_MESSAGE_ID,
    });
  });

  it("reconciles an existing channel to the current category and support role", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    const replacementRole = {
      id: NEW_SUPPORT_ROLE_ID,
      name: "Escalations",
      guild: harness.guild,
      managed: false,
    };
    harness.guild.roles.cache.set(NEW_SUPPORT_ROLE_ID, replacementRole);
    harness.guild.roles.fetch.mockImplementation(async (id: string) =>
      id === NEW_SUPPORT_ROLE_ID ? replacementRole : null,
    );
    harness.staffA.roles.cache.set(NEW_SUPPORT_ROLE_ID, replacementRole);
    harness.storage.upsertTicketConfiguration({
      categoryId: CATEGORY_ID,
      logChannelId: LOG_CHANNEL_ID,
      supportRoleId: NEW_SUPPORT_ROLE_ID,
    });
    const interaction = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.ticketChannel.edit).toHaveBeenCalledTimes(1);
    const edit = harness.ticketChannel.edit.mock.calls[0]?.[0];
    const overwriteIds = edit.permissionOverwrites.map(
      ({ id }: { id: string }) => id,
    );
    expect(edit).toMatchObject({ parent: CATEGORY_ID });
    expect(overwriteIds).toContain(NEW_SUPPORT_ROLE_ID);
    expect(overwriteIds).not.toContain(SUPPORT_ROLE_ID);
    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      channelId: TICKET_CHANNEL_ID,
      controlMessageId: CONTROL_MESSAGE_ID,
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Refreshed"),
      }),
    );
  });

  it("refreshes the tracked control instead of accumulating recovery messages", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    const first = createRecoveryInteraction(harness, ticket.ticketNumber);
    const second = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      first as never,
      harness.runtime,
      harness.staffA as never,
    );
    await handleTicketCommand(
      second as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.ticketControlEdit).toHaveBeenCalledTimes(2);
    expect(harness.ticketChannel.send).not.toHaveBeenCalled();
    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      channelId: TICKET_CHANNEL_ID,
      controlMessageId: CONTROL_MESSAGE_ID,
    });
  });

  it("does not post a replacement control after a transient message lookup failure", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.ticketChannel.messages.fetch.mockRejectedValueOnce(
      new Error("synthetic Discord message lookup outage"),
    );
    const interaction = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.ticketChannel.edit).not.toHaveBeenCalled();
    expect(harness.ticketControlEdit).not.toHaveBeenCalled();
    expect(harness.ticketChannel.send).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("could not verify"),
      }),
    );
  });

  it("does not rebind or retain a new control when close wins the recovery race", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.ticketChannel.messages.fetch.mockResolvedValueOnce(null);
    const newControlDelete = vi.fn(async () => undefined);
    harness.ticketChannel.send.mockImplementationOnce(async () => {
      const close = harness.storage.beginTicketClose(
        ticket.ticketId,
        STAFF_A_ID,
        "Concurrent close",
      );
      expect(close.status).toBe("started");
      return {
        id: RECOVERY_CONTROL_A,
        author: { id: BOT_ID },
        delete: newControlDelete,
      };
    });
    const interaction = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(newControlDelete).toHaveBeenCalledTimes(1);
    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      state: "closing",
      channelId: TICKET_CHANNEL_ID,
      controlMessageId: CONTROL_MESSAGE_ID,
      closeReason: "Concurrent close",
    });
    expect(
      harness.storage.listTicketEvents(ticket.ticketId).map(({ type }) => type),
    ).not.toEqual(expect.arrayContaining(["rebound"]));
  });

  it("quarantines an existing channel when recovery applies stale permissions", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    let current = true;
    (harness.runtime.isCurrent as ReturnType<typeof vi.fn>).mockImplementation(
      () => current,
    );
    harness.ticketChannel.edit.mockImplementationOnce(async () => {
      current = false;
      return harness.ticketChannel;
    });
    const interaction = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.ticketChannel.edit).toHaveBeenCalledTimes(2);
    const quarantine = harness.ticketChannel.edit.mock.calls[1]?.[0];
    const overwriteIds = quarantine.permissionOverwrites.map(
      ({ id }: { id: string }) => id,
    );
    expect(overwriteIds).toEqual(expect.arrayContaining([GUILD_ID, BOT_ID]));
    expect(overwriteIds).not.toContain(OPENER_ID);
    expect(overwriteIds).not.toContain(SUPPORT_ROLE_ID);
    expect(harness.ticketChannel.send).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("restricted"),
      }),
    );
  });

  it("quarantines a stale recreated channel when rollback deletion fails", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.guild.channels.fetch.mockImplementation(async (id: string) => {
      if (id === CATEGORY_ID) return harness.category;
      if (id === LOG_CHANNEL_ID) return harness.logChannel;
      if (id === PANEL_CHANNEL_ID) return harness.panelChannel;
      return null;
    });
    const recovered = createRecoveredChannel(
      harness,
      RECOVERY_CHANNEL_A,
      RECOVERY_CONTROL_A,
    );
    recovered.channel.delete.mockRejectedValueOnce(
      new Error("synthetic recovery deletion failure"),
    );
    let current = true;
    (harness.runtime.isCurrent as ReturnType<typeof vi.fn>).mockImplementation(
      () => current,
    );
    recovered.channel.send.mockImplementationOnce(async () => {
      current = false;
      return {
        id: RECOVERY_CONTROL_A,
        author: { id: BOT_ID },
        delete: recovered.controlDelete,
      };
    });
    harness.createChannel.mockResolvedValueOnce(recovered.channel);
    const interaction = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(recovered.channel.edit).toHaveBeenCalledTimes(1);
    const quarantine = recovered.channel.edit.mock.calls[0]?.[0];
    const overwriteIds = quarantine.permissionOverwrites.map(
      ({ id }: { id: string }) => id,
    );
    expect(overwriteIds).toEqual(expect.arrayContaining([GUILD_ID, BOT_ID]));
    expect(overwriteIds).not.toContain(OPENER_ID);
    expect(overwriteIds).not.toContain(SUPPORT_ROLE_ID);
    expect(harness.storage.getTicketById(ticket.ticketId)).toMatchObject({
      channelId: TICKET_CHANNEL_ID,
      controlMessageId: CONTROL_MESSAGE_ID,
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("restricted"),
      }),
    );
  });

  it("does not remove opener access when member lookup fails transiently", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.guild.members.fetch.mockRejectedValue(
      new Error("synthetic Discord API outage"),
    );
    const interaction = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.ticketChannel.edit).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("could not verify"),
      }),
    );
  });

  it("does not replace a live channel when its Discord lookup fails transiently", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.guild.channels.fetch.mockImplementation(async (id: string) => {
      if (id === TICKET_CHANNEL_ID) {
        throw new Error("synthetic Discord channel timeout");
      }
      return null;
    });
    const interaction = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.createChannel).not.toHaveBeenCalled();
    expect(harness.ticketChannel.edit).not.toHaveBeenCalled();
    expect(harness.ticketChannel.delete).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("could not verify the channel"),
      }),
    );
  });

  it("does not delete a closed channel when recovery becomes stale after fetch", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.storage.beginTicketClose(ticket.ticketId, STAFF_A_ID, "Resolved");
    harness.storage.markTicketLogDelivered(
      ticket.ticketId,
      "252525252525252525",
    );
    harness.storage.finishTicketClose(ticket.ticketId);
    let current = true;
    (harness.runtime.isCurrent as ReturnType<typeof vi.fn>).mockImplementation(
      () => current,
    );
    harness.guild.channels.fetch.mockImplementation(async (id: string) => {
      if (id === TICKET_CHANNEL_ID) {
        current = false;
        return harness.ticketChannel;
      }
      return null;
    });
    const interaction = createRecoveryInteraction(harness, ticket.ticketNumber);

    await handleTicketCommand(
      interaction as never,
      harness.runtime,
      harness.staffA as never,
    );

    expect(harness.ticketChannel.delete).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("No channel"),
      }),
    );
  });

  it("uses a durable compare-and-swap so concurrent recovery keeps one channel", async () => {
    const harness = createHarness();
    const ticket = createActiveTicket(harness)!;
    harness.guild.channels.fetch.mockImplementation(async (id: string) => {
      if (id === CATEGORY_ID) return harness.category;
      if (id === LOG_CHANNEL_ID) return harness.logChannel;
      if (id === PANEL_CHANNEL_ID) return harness.panelChannel;
      return null;
    });
    const firstRecovered = createRecoveredChannel(
      harness,
      RECOVERY_CHANNEL_A,
      RECOVERY_CONTROL_A,
    );
    const secondRecovered = createRecoveredChannel(
      harness,
      RECOVERY_CHANNEL_B,
      RECOVERY_CONTROL_B,
    );
    const recovered = [firstRecovered, secondRecovered];
    let createCount = 0;
    let releaseBoth!: () => void;
    const bothCreated = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    harness.createChannel.mockImplementation(async () => {
      const index = createCount;
      createCount += 1;
      if (createCount === recovered.length) releaseBoth();
      await bothCreated;
      return recovered[index]!.channel;
    });
    const first = createRecoveryInteraction(harness, ticket.ticketNumber);
    const second = createRecoveryInteraction(harness, ticket.ticketNumber);

    await Promise.all([
      handleTicketCommand(
        first as never,
        harness.runtime,
        harness.staffA as never,
      ),
      handleTicketCommand(
        second as never,
        harness.runtime,
        harness.staffA as never,
      ),
    ]);

    const persisted = harness.storage.getTicketById(ticket.ticketId)!;
    expect([RECOVERY_CHANNEL_A, RECOVERY_CHANNEL_B]).toContain(
      persisted.channelId,
    );
    expect([RECOVERY_CONTROL_A, RECOVERY_CONTROL_B]).toContain(
      persisted.controlMessageId,
    );
    const winner =
      persisted.channelId === RECOVERY_CHANNEL_A
        ? firstRecovered
        : secondRecovered;
    const loser =
      persisted.channelId === RECOVERY_CHANNEL_A
        ? secondRecovered
        : firstRecovered;
    expect(winner.channel.delete).not.toHaveBeenCalled();
    expect(loser.channel.delete).toHaveBeenCalledTimes(1);
    const successfulReplies = [first.reply, second.reply].filter((reply) =>
      (reply.mock.calls as unknown as Array<[{ content?: unknown }]>).some(
        ([payload]) => String(payload.content).includes("Recreated"),
      ),
    );
    expect(successfulReplies).toHaveLength(1);
  });
});

describe("ticket command authorization", () => {
  it("rejects a non-administrator before exposing ticket status", async () => {
    const harness = createHarness();
    const interaction: Record<string, any> = {
      commandName: "ticket",
      guild: harness.guild,
      guildId: GUILD_ID,
      user: { id: OUTSIDER_ID },
      options: { getSubcommand: vi.fn(() => "status") },
      deferred: false,
      replied: false,
      editReply: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    interaction.deferReply = vi.fn(async () => {
      interaction.deferred = true;
    });
    const processRuntime = {
      forGuild: vi.fn(async () => harness.runtime),
    } as unknown as BotRuntime;

    await handleChatInputCommand(interaction as never, processRuntime);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Only the server owner"),
      }),
    );
  });
});
