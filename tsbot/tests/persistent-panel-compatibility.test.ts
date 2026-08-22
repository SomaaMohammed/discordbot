import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ButtonStyle, ChannelType, PermissionFlagsBits } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleApplicationButton,
  handleApplicationSelect,
} from "../src/discord/application-interactions.js";
import {
  parseApplicationOpenCustomId,
  parseSuggestionOpenCustomId,
  parseTicketOpenCustomId,
  renderSuperiorPanel,
} from "../src/discord/panel-theme.js";
import {
  handlePanelButton,
  parsePersistentPanelButtonId,
} from "../src/discord/panels.js";
import type { GuildRuntime } from "../src/runtime.js";
import { handleSuggestionButton } from "../src/discord/suggestion-interactions.js";
import { handleTicketButton } from "../src/discord/ticket-interactions.js";
import {
  inspectApplicationResources,
  inspectSuggestionResources,
} from "../src/discord/phase2-permissions.js";
import { inspectTicketConfigurationResources } from "../src/discord/ticket-permissions.js";
import { BotStorage } from "../src/storage/db.js";
import {
  createDefaultLegacyGuildSettingsV2,
  serializeLegacyGuildSettingsV2,
} from "../src/storage/guild-settings-v2.js";
import {
  migrateDatabase,
  validateDatabaseFile,
} from "../src/storage/migration.js";
import { initializeV7Schema, validateV7Schema } from "../src/storage/schema.js";
import type {
  ApplicationForm,
  PanelPreset,
  SuggestionConfiguration,
  TicketConfiguration,
} from "../src/types.js";

const GUILD_ID = "111111111111111111";
const LEFT_GUILD_ID = "111111111111111112";
const ROLE_ID = "222222222222222222";
const TARGET_ID = "333333333333333333";
const NOW = "2026-08-01T00:00:00.000Z";
const roots: string[] = [];

const PANEL_FIXTURES: ReadonlyArray<{
  panelId: string;
  preset: PanelPreset;
  channelId: string;
  messageId: string;
  configuration: unknown;
}> = [
  {
    panelId: "help0001",
    preset: "help",
    channelId: "400000000000000001",
    messageId: "500000000000000001",
    configuration: {},
  },
  {
    panelId: "server01",
    preset: "server-info",
    channelId: "400000000000000002",
    messageId: "500000000000000002",
    configuration: {},
  },
  {
    panelId: "resource1",
    preset: "resources",
    channelId: "400000000000000003",
    messageId: "500000000000000003",
    configuration: {
      title: "Rules",
      body: "Read the current rules.",
      links: [{ label: "Guide", url: "https://example.com/guide" }],
    },
  },
  {
    panelId: "ticket01",
    preset: "tickets",
    channelId: "400000000000000004",
    messageId: "500000000000000004",
    configuration: { departmentId: "dept0001" },
  },
  {
    panelId: "suggest1",
    preset: "suggestions",
    channelId: "400000000000000005",
    messageId: "500000000000000005",
    configuration: { workflow: "suggestions" },
  },
  {
    panelId: "apply001",
    preset: "applications",
    channelId: "400000000000000006",
    messageId: "500000000000000006",
    configuration: { formId: "form0001" },
  },
];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("persistent panel compatibility", () => {
  it("retains every tracked preset, token, channel, and message across restarts", async () => {
    const dbFile = temporaryDatabase("restart.db");
    const componentIds = persistentComponentIds();
    expectStableRouters(componentIds);
    const first = new BotStorage({ dbFile });
    first.initStorage();
    first.ensureGuild(GUILD_ID);
    const guild = first.forGuild(GUILD_ID);
    for (const panel of PANEL_FIXTURES) guild.createPostedPanel(panel);
    seedWorkflowPanelBindings(guild);
    const expected = guild.listPostedPanels();
    first.close();

    const second = new BotStorage({ dbFile });
    second.initStorage();
    expect(second.forGuild(GUILD_ID).listPostedPanels()).toEqual(expected);
    expectStableRouters(componentIds);
    await expectStatelessPanelHandlers(second);
    await expectWorkflowPanelHandlers(second);
    expectStaticPanelCompatibility(second);
    second.close();

    const third = new BotStorage({ dbFile });
    third.initStorage();
    expect(third.forGuild(GUILD_ID).listPostedPanels()).toEqual(expected);
    expectStableRouters(componentIds);
    await expectStatelessPanelHandlers(third);
    await expectWorkflowPanelHandlers(third);
    expectStaticPanelCompatibility(third);
    third.close();
  });

  it("isolates precise deleted-resource and missing-permission recovery", async () => {
    const dbFile = temporaryDatabase("recovery.db");
    const storage = new BotStorage({ dbFile });
    storage.initStorage();
    storage.ensureGuild(GUILD_ID);
    const guildStorage = storage.forGuild(GUILD_ID);
    for (const panel of PANEL_FIXTURES) guildStorage.createPostedPanel(panel);
    const before = guildStorage.listPostedPanels();
    const configurations = workflowConfigurations();

    const missingGuild = recoveryGuild("missing");
    const [missingTicket, missingSuggestion, missingApplication] =
      await Promise.all([
        inspectTicketConfigurationResources(
          missingGuild as never,
          configurations.ticket,
        ),
        inspectSuggestionResources(
          missingGuild as never,
          configurations.suggestion,
        ),
        inspectApplicationResources(
          missingGuild as never,
          configurations.application,
        ),
      ]);
    expect(missingTicket.issues).toEqual(
      expect.arrayContaining([
        "The configured ticket category is missing.",
        "The configured ticket log channel is missing.",
        "The configured ticket support role is missing.",
      ]),
    );
    expect(missingSuggestion.issues).toEqual(
      expect.arrayContaining([
        "The configured suggestion channel is missing or invalid.",
        "The configured suggestion review channel is missing or invalid.",
        "The configured suggestion reviewer role is missing or belongs to another server.",
      ]),
    );
    expect(missingApplication.issues).toEqual(
      expect.arrayContaining([
        "The configured private application review channel is missing or invalid.",
        "The configured application reviewer role is missing or belongs to another server.",
      ]),
    );

    const deniedGuild = recoveryGuild("denied");
    const [deniedTicket, deniedSuggestion, deniedApplication] =
      await Promise.all([
        inspectTicketConfigurationResources(
          deniedGuild as never,
          configurations.ticket,
        ),
        inspectSuggestionResources(
          deniedGuild as never,
          configurations.suggestion,
        ),
        inspectApplicationResources(
          deniedGuild as never,
          configurations.application,
        ),
      ]);
    expect(deniedTicket.issues).toEqual(
      expect.arrayContaining([
        "Superior needs Manage Channels to create and remove tickets.",
        "Superior needs View Channel, Send Messages, Read Message History, Embed Links, Attach Files, Manage Channels, and Manage Roles in the ticket category.",
      ]),
    );
    expect(deniedSuggestion.issues).toEqual(
      expect.arrayContaining([
        "Superior is missing required permissions in the suggestion channel.",
        "Superior is missing required permissions in the suggestion review channel.",
      ]),
    );
    expect(deniedApplication.issues).toEqual(
      expect.arrayContaining([
        "Superior is missing required permissions in the application review channel.",
        "The delegated reviewer role needs View Channel, Send Messages, and Read Message History in the private application review channel.",
      ]),
    );

    expect(guildStorage.listPostedPanels()).toEqual(before);
    storage.close();
  });

  it("migrates v7 to v9 without changing panels, workflow bindings, or component IDs", async () => {
    const dbFile = temporaryDatabase("v7-panels.db");
    createV7PanelFixture(dbFile);
    const before = readCompatibilityRows(dbFile);
    const componentIds = persistentComponentIds();

    expect(validateDatabaseFile(dbFile, { expect: 7 }).schema).toBe(
      "legacy-v7",
    );
    expect(migrateDatabase({ dbFile, now: () => NOW })).toMatchObject({
      status: "migrated",
      fromSchema: "legacy-v7",
      toSchema: "current-v9",
    });
    expect(validateDatabaseFile(dbFile, { expect: 9 }).schema).toBe(
      "current-v9",
    );
    expect(readCompatibilityRows(dbFile)).toEqual(before);
    expect(componentIds).toEqual(persistentComponentIds());
    expectStableRouters(componentIds);

    const oldValidator = new Database(dbFile, { readonly: true });
    try {
      expect(validateV7Schema(oldValidator)).not.toEqual([]);
    } finally {
      oldValidator.close();
    }

    for (let restart = 0; restart < 2; restart += 1) {
      const storage = new BotStorage({ dbFile });
      storage.initStorage();
      expect(storage.forGuild(GUILD_ID).listPostedPanels()).toEqual(
        expectedPostedPanels(),
      );
      expect(storage.getGuildSettings(GUILD_ID)).toMatchObject({
        version: 3,
        enabled: true,
        greetings: [{ name: "Welcome", message: "Welcome, {user}!" }],
      });
      expect(storage.getGuildSettings(LEFT_GUILD_ID)).toMatchObject({
        version: 3,
        enabled: false,
      });
      await expectStatelessPanelHandlers(storage);
      await expectWorkflowPanelHandlers(storage);
      expectStaticPanelCompatibility(storage);
      storage.close();
    }
  });

  it.each([
    "after-source-read",
    "after-rename",
    "after-create",
    "after-copy",
    "after-verify",
    "after-drop",
    "after-version",
    "before-commit",
  ] as const)(
    "rolls v7 panel data back after %s failure",
    (failurePoint) => {
      const dbFile = temporaryDatabase(`rollback-${failurePoint}.db`);
      createV7PanelFixture(dbFile);
      const beforeFile = fs.readFileSync(dbFile);
      const beforeRows = readCompatibilityRows(dbFile);

      expect(() => migrateDatabase({ dbFile, failurePoint })).toThrow(
        /Injected migration failure/,
      );
      expect(readCompatibilityRows(dbFile)).toEqual(beforeRows);
      expect(validateDatabaseFile(dbFile, { expect: 7 }).schema).toBe(
        "legacy-v7",
      );
      expect(fs.readFileSync(dbFile)).toEqual(beforeFile);
    },
    30_000,
  );
});

function createV7PanelFixture(dbFile: string): void {
  const db = new Database(dbFile);
  db.pragma("foreign_keys = ON");
  initializeV7Schema(db, NOW);
  const settings = createDefaultLegacyGuildSettingsV2();
  const insertGuild = db.prepare(
    `INSERT INTO guilds (
       guild_id, enabled, name, joined_at, left_at, created_at, updated_at
     ) VALUES (?, 0, ?, ?, ?, ?, ?)`,
  );
  insertGuild.run(GUILD_ID, "Panel Guild", NOW, null, NOW, NOW);
  insertGuild.run(LEFT_GUILD_ID, "Left Guild", NOW, NOW, NOW, NOW);
  const insertSettings = db.prepare(
    `INSERT INTO guild_settings (
       guild_id, settings_version, settings_json, updated_at
     ) VALUES (?, 2, ?, ?)`,
  );
  insertSettings.run(GUILD_ID, serializeLegacyGuildSettingsV2(settings), NOW);
  insertSettings.run(
    LEFT_GUILD_ID,
    serializeLegacyGuildSettingsV2(settings),
    NOW,
  );

  const insertPanel = db.prepare(
    `INSERT INTO posted_panels (
       guild_id, panel_id, preset, channel_id, message_id,
       configuration_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const panel of PANEL_FIXTURES) {
    insertPanel.run(
      GUILD_ID,
      panel.panelId,
      panel.preset,
      panel.channelId,
      panel.messageId,
      JSON.stringify(panel.configuration),
      NOW,
      NOW,
    );
  }

  db.prepare(
    `INSERT INTO ticket_departments (
       guild_id, department_id, slug, display_name, description, emoji,
       category_id, log_channel_id, support_role_id, enabled, sort_order,
       definition_version, bindings_verified_at, created_at, updated_at
     ) VALUES (?, 'dept0001', 'support', 'Support', 'Private support', NULL,
       ?, ?, ?, 1, 0, 4, ?, ?, ?)`,
  ).run(
    GUILD_ID,
    "600000000000000001",
    "600000000000000002",
    "600000000000000003",
    NOW,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO ticket_department_fields (
       guild_id, department_id, field_id, label, description, placeholder,
       field_type, required, min_length, max_length, sort_order,
       created_at, updated_at
     ) VALUES (?, 'dept0001', 'ticketf1', 'Details', NULL, NULL,
       'paragraph', 1, 1, 1000, 0, ?, ?)`,
  ).run(GUILD_ID, NOW, NOW);
  db.prepare(
    `INSERT INTO suggestion_configurations (
       guild_id, enabled, suggestion_channel_id, review_channel_id,
       reviewer_role_id, create_threads, cooldown_limit,
       cooldown_window_seconds, allow_self_votes, bindings_verified_at,
       created_at, updated_at
     ) VALUES (?, 1, ?, ?, ?, 0, 3, 600, 0, ?, ?, ?)`,
  ).run(
    GUILD_ID,
    "610000000000000001",
    "610000000000000002",
    "610000000000000003",
    NOW,
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO application_forms (
       guild_id, form_id, slug, display_name, description, reviewer_role_id,
       review_channel_id, enabled, sort_order, definition_version,
       bindings_verified_at, created_at, updated_at
     ) VALUES (?, 'form0001', 'staff', 'Staff', 'Private staff form', ?, ?,
       1, 0, 7, ?, ?, ?)`,
  ).run(GUILD_ID, "620000000000000001", "620000000000000002", NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO application_form_fields (
       guild_id, form_id, field_id, label, description, placeholder,
       field_type, required, min_length, max_length, sort_order,
       created_at, updated_at
     ) VALUES (?, 'form0001', 'appfld01', 'Why?', NULL, NULL,
       'paragraph', 1, 1, 1000, 0, ?, ?)`,
  ).run(GUILD_ID, NOW, NOW);
  expect(validateV7Schema(db)).toEqual([]);
  db.close();
}

function readCompatibilityRows(dbFile: string): Record<string, unknown[]> {
  const db = new Database(dbFile, { readonly: true });
  try {
    return Object.fromEntries(
      [
        "posted_panels",
        "ticket_departments",
        "ticket_department_fields",
        "suggestion_configurations",
        "application_forms",
        "application_form_fields",
      ].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}

function persistentComponentIds(): Record<string, string> {
  return {
    role: `superior:role:${ROLE_ID}`,
    privateMessage: `superior:dm:${TARGET_ID}`,
    ticket: "superior:ticket:open:ticket01",
    suggestion: "superior:suggestion:open:suggest1",
    application: "superior:application:open:apply001",
  };
}

function expectStableRouters(ids: Record<string, string>): void {
  expect(parsePersistentPanelButtonId(ids.role!)).toEqual({
    kind: "role",
    roleId: ROLE_ID,
  });
  expect(parsePersistentPanelButtonId(ids.privateMessage!)).toEqual({
    kind: "private-message",
    targetId: TARGET_ID,
  });
  expect(parseTicketOpenCustomId(ids.ticket!)).toBe("ticket01");
  expect(parseSuggestionOpenCustomId(ids.suggestion!)).toBe("suggest1");
  expect(parseApplicationOpenCustomId(ids.application!)).toBe("apply001");
}

function seedWorkflowPanelBindings(
  storage: ReturnType<BotStorage["forGuild"]>,
): void {
  const department = storage.createTicketDepartment({
    departmentId: "dept0001",
    slug: "support",
    displayName: "Support",
    description: "Private support",
    categoryId: "600000000000000001",
    logChannelId: "600000000000000002",
    supportRoleId: "600000000000000003",
    enabled: true,
    bindingsVerifiedAt: NOW,
  });
  storage.upsertTicketDepartmentField(department.departmentId, {
    fieldId: "ticketf1",
    label: "Details",
    fieldType: "paragraph",
    required: true,
    minLength: 1,
    maxLength: 1_000,
  });
  storage.upsertSuggestionConfiguration({
    suggestionChannelId: "610000000000000001",
    reviewChannelId: "610000000000000002",
    reviewerRoleId: "610000000000000003",
    enabled: true,
    bindingsVerifiedAt: NOW,
  });
  const form = storage.createApplicationForm({
    formId: "form0001",
    slug: "staff",
    displayName: "Staff",
    description: "Private staff form",
    reviewerRoleId: "620000000000000001",
    reviewChannelId: "620000000000000002",
    enabled: false,
    bindingsVerifiedAt: NOW,
  });
  storage.upsertApplicationFormField(form.formId, {
    fieldId: "appfld01",
    label: "Why?",
    fieldType: "paragraph",
    required: true,
    minLength: 1,
    maxLength: 1_000,
  });
  storage.setApplicationFormEnabled(form.formId, true);
}

async function expectStatelessPanelHandlers(
  storage: BotStorage,
): Promise<void> {
  const userId = "730000000000000001";
  const botId = "730000000000000002";
  const panelMessageId = "730000000000000003";
  const guild: Record<string, any> = {
    id: GUILD_ID,
    ownerId: "730000000000000004",
    channels: { cache: new Map() },
  };
  const role = {
    id: ROLE_ID,
    name: "Member",
    guild,
    managed: false,
    permissions: { bitfield: 0n },
  };
  const add = vi.fn(async () => undefined);
  const member = {
    id: userId,
    guild,
    roles: { cache: new Map(), add, remove: vi.fn(async () => undefined) },
  };
  const botMember = {
    id: botId,
    guild,
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: () => 1 } },
  };
  guild.members = {
    me: botMember,
    fetch: vi.fn(async () => member),
    fetchMe: vi.fn(async () => botMember),
  };
  guild.roles = { fetch: vi.fn(async () => role) };
  const runtime = {
    guildId: GUILD_ID,
    isCurrent: vi.fn(() => true),
    storage: storage.forGuild(GUILD_ID),
  } as unknown as GuildRuntime;
  let deferred = false;
  const editReply = vi.fn(async () => undefined);
  const roleInteraction = {
    customId: `superior:role:${ROLE_ID}`,
    guild,
    user: { id: userId },
    client: { user: { id: botId } },
    message: { id: panelMessageId, author: { id: botId } },
    get deferred() {
      return deferred;
    },
    replied: false,
    deferReply: vi.fn(async () => {
      deferred = true;
    }),
    editReply,
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };

  expect(await handlePanelButton(roleInteraction as never, runtime)).toBe(true);
  expect(add).toHaveBeenCalledWith(role, "Self-service role panel");
  expect(editReply).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringContaining("Added") }),
  );

  const showModal = vi.fn(async () => undefined);
  const dmInteraction = {
    customId: `superior:dm:${TARGET_ID}`,
    guild,
    user: { id: userId },
    client: { user: { id: botId } },
    message: { id: panelMessageId, author: { id: botId } },
    showModal,
  };
  expect(await handlePanelButton(dmInteraction as never, runtime)).toBe(true);
  expect(showModal).toHaveBeenCalledTimes(1);
}

async function expectWorkflowPanelHandlers(storage: BotStorage): Promise<void> {
  const botId = "740000000000000001";
  const launcherAuthor = { id: botId };
  const applicationLauncher = {
    id: "500000000000000006",
    author: launcherAuthor,
  };
  const applicationChannel = {
    id: "400000000000000006",
    type: ChannelType.GuildText,
    messages: {
      fetch: vi.fn(async () => applicationLauncher),
    },
  };
  const guild = {
    id: GUILD_ID,
    channels: {
      fetch: vi.fn(async (channelId: string) =>
        channelId === applicationChannel.id ? applicationChannel : null,
      ),
    },
  };
  const runtime = {
    guildId: GUILD_ID,
    isCurrent: vi.fn(() => true),
    storage: storage.forGuild(GUILD_ID),
  } as unknown as GuildRuntime;

  const ticketShowModal = vi.fn(async (_modal: unknown) => undefined);
  const ticket = panelButtonInteraction({
    customId: "superior:ticket:open:ticket01",
    channelId: "400000000000000004",
    messageId: "500000000000000004",
    botId,
    guild,
    showModal: ticketShowModal,
  });
  expect(await handleTicketButton(ticket as never, runtime)).toBe(true);
  expect(ticketShowModal).toHaveBeenCalledTimes(1);
  expect(componentCustomId(ticketShowModal.mock.calls[0]![0])).toMatch(
    /^superior:ticket:open-modal:ticket01:dept0001:\d+$/u,
  );

  const suggestionShowModal = vi.fn(async (_modal: unknown) => undefined);
  const suggestion = panelButtonInteraction({
    customId: "superior:suggestion:open:suggest1",
    channelId: "400000000000000005",
    messageId: "500000000000000005",
    botId,
    guild,
    showModal: suggestionShowModal,
  });
  expect(await handleSuggestionButton(suggestion as never, runtime)).toBe(true);
  expect(suggestionShowModal).toHaveBeenCalledTimes(1);
  expect(componentCustomId(suggestionShowModal.mock.calls[0]![0])).toBe(
    "superior:suggestion:submit-modal:suggest1",
  );

  const application = panelButtonInteraction({
    customId: "superior:application:open:apply001",
    channelId: "400000000000000006",
    messageId: "500000000000000006",
    botId,
    guild,
  });
  expect(await handleApplicationButton(application as never, runtime)).toBe(
    true,
  );
  expect(application.reply).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining("Choose the private application"),
      components: expect.any(Array),
    }),
  );

  const applicationShowModal = vi.fn(async (_modal: unknown) => undefined);
  const applicationSelect = {
    customId: "superior:application:select:apply001",
    values: ["form0001"],
    guild,
    guildId: GUILD_ID,
    channelId: "400000000000000006",
    user: { id: "740000000000000002" },
    client: { user: { id: botId } },
    deferred: false,
    replied: false,
    showModal: applicationShowModal,
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  expect(
    await handleApplicationSelect(applicationSelect as never, runtime),
  ).toBe(true);
  expect(applicationShowModal).toHaveBeenCalledTimes(1);
  expect(componentCustomId(applicationShowModal.mock.calls[0]![0])).toMatch(
    /^superior:application:submit-modal:apply001:form0001:\d+$/u,
  );
}

function panelButtonInteraction(options: {
  customId: string;
  channelId: string;
  messageId: string;
  botId: string;
  guild: Record<string, unknown>;
  showModal?: (modal: unknown) => Promise<void>;
}) {
  return {
    customId: options.customId,
    guild: options.guild,
    guildId: GUILD_ID,
    channelId: options.channelId,
    user: { id: "740000000000000002" },
    client: { user: { id: options.botId } },
    message: {
      id: options.messageId,
      author: { id: options.botId },
    },
    deferred: false,
    replied: false,
    showModal: options.showModal ?? vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
}

function componentCustomId(component: unknown): string | undefined {
  return (component as { toJSON: () => { custom_id?: string } }).toJSON()
    .custom_id;
}

function expectStaticPanelCompatibility(storage: BotStorage): void {
  const panels = storage.forGuild(GUILD_ID).listPostedPanels();
  const help = panels.find((panel) => panel.preset === "help");
  const resources = panels.find((panel) => panel.preset === "resources");
  expect(help).toMatchObject({
    panelId: "help0001",
    channelId: "400000000000000001",
    messageId: "500000000000000001",
    configuration: {},
  });
  expect(resources).toMatchObject({
    panelId: "resource1",
    channelId: "400000000000000003",
    messageId: "500000000000000003",
    configuration: {
      title: "Rules",
      body: "Read the current rules.",
      links: [{ label: "Guide", url: "https://example.com/guide" }],
    },
  });

  const helpPayload = renderSuperiorPanel({
    preset: "help",
    features: {
      chat: true,
      replyModeration: true,
      greetings: true,
      activityMetrics: true,
      tickets: true,
      suggestions: true,
      applications: true,
    },
  });
  expect(helpPayload.components).toEqual([]);

  const resourcePayload = renderSuperiorPanel({
    preset: "resources",
    resource: resources!.configuration as {
      title: string;
      body: string;
      links: Array<{ label: string; url: string }>;
    },
  });
  const buttons = resourcePayload.components.flatMap(
    (row) => row.toJSON().components,
  );
  expect(buttons).toEqual([
    expect.objectContaining({
      style: ButtonStyle.Link,
      url: "https://example.com/guide",
    }),
  ]);
  expect(buttons[0]).not.toHaveProperty("custom_id");
}

function expectedPostedPanels() {
  return [...PANEL_FIXTURES]
    .sort((left, right) =>
      `${left.preset}\0${left.channelId}\0${left.panelId}`.localeCompare(
        `${right.preset}\0${right.channelId}\0${right.panelId}`,
      ),
    )
    .map((panel) => ({
      guildId: GUILD_ID,
      ...panel,
      createdAt: NOW,
      updatedAt: NOW,
    }));
}

function workflowConfigurations(): {
  ticket: TicketConfiguration;
  suggestion: SuggestionConfiguration;
  application: ApplicationForm;
} {
  return {
    ticket: {
      guildId: GUILD_ID,
      departmentId: "dept0001",
      enabled: true,
      categoryId: "600000000000000001",
      logChannelId: "600000000000000002",
      supportRoleId: "600000000000000003",
      createdAt: NOW,
      updatedAt: NOW,
    },
    suggestion: {
      guildId: GUILD_ID,
      enabled: true,
      suggestionChannelId: "610000000000000001",
      reviewChannelId: "610000000000000002",
      reviewerRoleId: "610000000000000003",
      createThreads: false,
      cooldownLimit: 3,
      cooldownWindowSeconds: 600,
      allowSelfVotes: false,
      bindingsVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    application: {
      guildId: GUILD_ID,
      formId: "form0001",
      slug: "staff",
      displayName: "Staff",
      description: "Private staff form",
      reviewerRoleId: "620000000000000001",
      reviewChannelId: "620000000000000002",
      enabled: true,
      sortOrder: 0,
      definitionVersion: 7,
      bindingsVerifiedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function recoveryGuild(mode: "missing" | "denied"): Record<string, any> {
  const guild: Record<string, any> = { id: GUILD_ID };
  const everyone = { id: GUILD_ID, guild, managed: false };
  const roleIds = new Set([
    "600000000000000003",
    "610000000000000003",
    "620000000000000001",
  ]);
  const roles = new Map(
    [...roleIds].map((id) => [id, { id, guild, managed: false }]),
  );
  const permissions = {
    has: (_permission: bigint) => mode !== "denied",
  };
  const channel = (id: string, type: ChannelType) => ({
    id,
    guild,
    type,
    isDMBased: () => false,
    permissionsFor: (subject: unknown) => ({
      has: (permission: bigint) =>
        subject === everyone && permission === PermissionFlagsBits.ViewChannel
          ? false
          : mode !== "denied",
    }),
  });
  const channels = new Map([
    [
      "600000000000000001",
      channel("600000000000000001", ChannelType.GuildCategory),
    ],
    [
      "600000000000000002",
      channel("600000000000000002", ChannelType.GuildText),
    ],
    [
      "610000000000000001",
      channel("610000000000000001", ChannelType.GuildText),
    ],
    [
      "610000000000000002",
      channel("610000000000000002", ChannelType.GuildText),
    ],
    [
      "620000000000000002",
      channel("620000000000000002", ChannelType.GuildText),
    ],
  ]);
  const botMember = {
    id: "700000000000000001",
    guild,
    permissions,
    roles: { highest: { comparePositionTo: () => 1 } },
  };
  guild.roles = {
    everyone,
    fetch: async (id: string) => (mode === "missing" ? null : roles.get(id)),
  };
  guild.channels = {
    fetch: async (id: string) => (mode === "missing" ? null : channels.get(id)),
  };
  guild.members = { fetchMe: async () => botMember };
  return guild;
}

function temporaryDatabase(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superior-panels-"));
  roots.push(root);
  return path.join(root, name);
}
