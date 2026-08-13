import {
  ChannelType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import type {
  TicketDepartment,
  TicketDepartmentDeleteResult,
  TicketDepartmentField,
  TicketDepartmentFieldInput,
  TicketDepartmentInput,
  TicketDepartmentUpdate,
} from "../src/types.js";
import {
  handleTicketDepartmentCommand,
  type TicketDepartmentStorage,
} from "../src/discord/ticket-department-commands-handler.js";

const GUILD_ID = "11111111111111111";
const OTHER_GUILD_ID = "22222222222222222";
const CATEGORY_ID = "33333333333333333";
const LOG_CHANNEL_ID = "44444444444444444";
const SUPPORT_ROLE_ID = "55555555555555555";
const NEW_CATEGORY_ID = "66666666666666666";
const DEPARTMENT_ID = "deptGeneral1";
const FIXED_NOW = "2026-08-01T12:00:00.000Z";

type Harness = ReturnType<typeof createHarness>;

function department(
  overrides: Partial<TicketDepartment> = {},
): TicketDepartment {
  return {
    guildId: GUILD_ID,
    departmentId: DEPARTMENT_ID,
    slug: "general-support",
    displayName: "General Support",
    description: "Private support from the court team.",
    emoji: "🎫",
    categoryId: CATEGORY_ID,
    logChannelId: LOG_CHANNEL_ID,
    supportRoleId: SUPPORT_ROLE_ID,
    enabled: false,
    sortOrder: 0,
    definitionVersion: 1,
    bindingsVerifiedAt: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function field(
  fieldId: string,
  sortOrder: number,
  overrides: Partial<TicketDepartmentField> = {},
): TicketDepartmentField {
  return {
    guildId: GUILD_ID,
    departmentId: DEPARTMENT_ID,
    fieldId,
    label: fieldId,
    description: null,
    placeholder: null,
    fieldType: "short",
    required: true,
    minLength: 1,
    maxLength: 400,
    sortOrder,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function createHarness(options: {
  group?: "department" | "field";
  subcommand?: string;
  strings?: Record<string, string | null>;
  integers?: Record<string, number | null>;
  booleans?: Record<string, boolean | null>;
  channels?: Record<string, unknown>;
  roles?: Record<string, unknown>;
  departments?: TicketDepartment[];
  fields?: TicketDepartmentField[];
  current?: boolean;
  categoryPermissions?: boolean;
  actorCanViewLog?: boolean;
  deleteStatus?: TicketDepartmentDeleteResult["status"];
}) {
  const category = channel(CATEGORY_ID, ChannelType.GuildCategory, {
    permissions: options.categoryPermissions ?? true,
  });
  const logChannel = channel(LOG_CHANNEL_ID, ChannelType.GuildText);
  const supportRole = role(SUPPORT_ROLE_ID);
  const channels = new Map<string, any>([
    [CATEGORY_ID, category],
    [LOG_CHANNEL_ID, logChannel],
    [NEW_CATEGORY_ID, channel(NEW_CATEGORY_ID, ChannelType.GuildCategory)],
  ]);
  const roles = new Map<string, any>([[SUPPORT_ROLE_ID, supportRole]]);
  const botMember = {
    id: "77777777777777777",
    guild: { id: GUILD_ID },
    permissions: { has: vi.fn(() => true) },
    roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
  };
  const guild: any = {
    id: GUILD_ID,
    ownerId: "88888888888888888",
    channels: {
      fetch: vi.fn(async (id: string) => channels.get(id) ?? null),
    },
    roles: {
      everyone: { id: GUILD_ID },
      fetch: vi.fn(async (id: string) => roles.get(id) ?? null),
    },
    members: {
      me: botMember,
      fetchMe: vi.fn(async () => botMember),
    },
  };

  const departmentMap = new Map(
    (options.departments ?? [department()]).map((item) => [
      item.departmentId,
      structuredClone(item),
    ]),
  );
  const fieldMap = new Map<string, TicketDepartmentField[]>();
  for (const item of options.fields ?? []) {
    const values = fieldMap.get(item.departmentId) ?? [];
    values.push(structuredClone(item));
    fieldMap.set(item.departmentId, values);
  }
  let sequence = 1;
  const touchDepartment = (departmentId: string) => {
    const current = departmentMap.get(departmentId);
    if (!current) return null;
    const updated = {
      ...current,
      definitionVersion: current.definitionVersion + 1,
      updatedAt: `2026-08-01T12:00:0${sequence++}.000Z`,
    };
    departmentMap.set(departmentId, updated);
    return updated;
  };

  const storage: TicketDepartmentStorage & {
    recordCommandMetric: ReturnType<typeof vi.fn>;
  } = {
    createTicketDepartment: vi.fn((input: TicketDepartmentInput) => {
      const created = department({
        ...input,
        departmentId: input.departmentId ?? `department${departmentMap.size}`,
        guildId: GUILD_ID,
        emoji: input.emoji ?? null,
        categoryId: input.categoryId ?? null,
        logChannelId: input.logChannelId ?? null,
        supportRoleId: input.supportRoleId ?? null,
        enabled: input.enabled ?? false,
        sortOrder: input.sortOrder ?? 0,
        bindingsVerifiedAt: input.bindingsVerifiedAt ?? null,
      });
      departmentMap.set(created.departmentId, created);
      return created;
    }),
    updateTicketDepartment: vi.fn(
      (departmentId: string, update: TicketDepartmentUpdate) => {
        const current = departmentMap.get(departmentId);
        if (!current) return null;
        const saved = {
          ...current,
          ...update,
          definitionVersion: current.definitionVersion + 1,
          updatedAt: `2026-08-01T12:00:0${sequence++}.000Z`,
        };
        departmentMap.set(departmentId, saved);
        return saved;
      },
    ),
    setTicketDepartmentEnabled: vi.fn(
      (departmentId: string, enabled: boolean) => {
        const current = departmentMap.get(departmentId);
        if (!current) return null;
        const saved = {
          ...current,
          enabled,
          definitionVersion: current.definitionVersion + 1,
          updatedAt: `2026-08-01T12:00:0${sequence++}.000Z`,
        };
        departmentMap.set(departmentId, saved);
        return saved;
      },
    ),
    deleteTicketDepartment: vi.fn((departmentId: string) => {
      const current = departmentMap.get(departmentId) ?? null;
      const status = options.deleteStatus ?? "deleted";
      if (status === "deleted" && current) departmentMap.delete(departmentId);
      return status === "deleted"
        ? { status, department: current! }
        : { status, department: current };
    }),
    getTicketDepartment: vi.fn(
      (departmentId: string) => departmentMap.get(departmentId) ?? null,
    ),
    getTicketDepartmentBySlug: vi.fn(
      (slug: string) =>
        [...departmentMap.values()].find((item) => item.slug === slug) ?? null,
    ),
    listTicketDepartments: vi.fn(
      (listOptions: { limit?: number; offset?: number } = {}) =>
        [...departmentMap.values()]
          .sort(
            (left, right) =>
              left.sortOrder - right.sortOrder ||
              left.departmentId.localeCompare(right.departmentId),
          )
          .slice(
            listOptions.offset ?? 0,
            (listOptions.offset ?? 0) + (listOptions.limit ?? 10),
          ),
    ),
    countTicketDepartments: vi.fn(() => departmentMap.size),
    upsertTicketDepartmentField: vi.fn(
      (departmentId: string, input: TicketDepartmentFieldInput) => {
        const values = fieldMap.get(departmentId) ?? [];
        const current = values.find((item) => item.fieldId === input.fieldId);
        const used = new Set(values.map((item) => item.sortOrder));
        let free = 0;
        while (used.has(free)) free += 1;
        const saved = field(
          input.fieldId ?? `fieldKey${values.length}`,
          input.sortOrder ?? current?.sortOrder ?? free,
          {
            ...current,
            label: input.label,
            description: input.description ?? null,
            placeholder: input.placeholder ?? null,
            fieldType: input.fieldType,
            required: input.required ?? true,
            minLength: input.minLength ?? 1,
            maxLength: input.maxLength ?? 400,
          },
        );
        fieldMap.set(departmentId, [
          ...values.filter((item) => item.fieldId !== saved.fieldId),
          saved,
        ]);
        touchDepartment(departmentId);
        return saved;
      },
    ),
    removeTicketDepartmentField: vi.fn(
      (departmentId: string, fieldId: string) => {
        const values = fieldMap.get(departmentId) ?? [];
        const next = values.filter((item) => item.fieldId !== fieldId);
        if (next.length === values.length) return false;
        fieldMap.set(departmentId, next);
        touchDepartment(departmentId);
        return true;
      },
    ),
    reorderTicketDepartmentFields: vi.fn(
      (departmentId: string, fieldIds: readonly string[]) => {
        const values = fieldMap.get(departmentId) ?? [];
        const next = fieldIds.map((fieldId, sortOrder) => ({
          ...values.find((item) => item.fieldId === fieldId)!,
          sortOrder,
        }));
        fieldMap.set(departmentId, next);
        touchDepartment(departmentId);
        return next;
      },
    ),
    getTicketDepartmentField: vi.fn(
      (departmentId: string, fieldId: string) =>
        (fieldMap.get(departmentId) ?? []).find(
          (item) => item.fieldId === fieldId,
        ) ?? null,
    ),
    listTicketDepartmentFields: vi.fn((departmentId: string) =>
      [...(fieldMap.get(departmentId) ?? [])].sort(
        (left, right) => left.sortOrder - right.sortOrder,
      ),
    ),
    listCapabilitiesForRoles: vi.fn(() => []),
    listCapabilityGrantsForCapability: vi.fn(() => []),
    hasActiveTicketsForDepartment: vi.fn(() => false),
    recordCommandMetric: vi.fn(),
  };

  const strings: Record<string, string | null> = {
    department: "general-support",
    ...options.strings,
  };
  const integers = options.integers ?? {};
  const booleans = options.booleans ?? {};
  const selectedChannels = options.channels ?? {};
  const selectedRoles = options.roles ?? {};
  const actor = {
    id: "99999999999999999",
    guild,
    permissions: { has: vi.fn(() => false) },
    roles: {
      cache: new Map<string, unknown>(),
      highest: { comparePositionTo: vi.fn(() => 1) },
    },
  };
  logChannel.permissionsFor.mockImplementation((subject: unknown) => ({
    has: vi.fn((permission?: bigint) =>
      subject === actor && permission === PermissionFlagsBits.ViewChannel
        ? (options.actorCanViewLog ?? false)
        : true,
    ),
  }));
  guild.members.fetch = vi.fn(async () => actor);
  const interaction: any = {
    guild,
    guildId: GUILD_ID,
    user: { id: "99999999999999999" },
    deferred: false,
    replied: false,
    options: {
      getSubcommandGroup: vi.fn(() => options.group ?? "department"),
      getSubcommand: vi.fn(() => options.subcommand ?? "list"),
      getString: vi.fn((name: string) => strings[name] ?? null),
      getInteger: vi.fn((name: string) => integers[name] ?? null),
      getBoolean: vi.fn((name: string) => booleans[name] ?? null),
      getChannel: vi.fn((name: string) => selectedChannels[name] ?? null),
      getRole: vi.fn((name: string) => selectedRoles[name] ?? null),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
  };
  const runtime = {
    guildId: GUILD_ID,
    storage,
    isCurrent: vi.fn(() => options.current ?? true),
    invalidate: vi.fn(),
    now: vi.fn(() => ({
      toUTC: () => ({ toISO: () => FIXED_NOW }),
    })),
  } as unknown as GuildRuntime;
  return {
    interaction: interaction as ChatInputCommandInteraction,
    runtime,
    storage,
    guild,
    channels,
    roles,
    category,
    logChannel,
    supportRole,
    actor,
    departmentMap,
    fieldMap,
  };
}

async function runTicketDepartmentCommand(harness: Harness): Promise<void> {
  await handleTicketDepartmentCommand(
    harness.interaction,
    harness.runtime,
    harness.actor as never,
  );
}

function channel(
  id: string,
  type: ChannelType,
  options: { guildId?: string; permissions?: boolean } = {},
) {
  return {
    id,
    name: `channel-${id.slice(-3)}`,
    type,
    guild: { id: options.guildId ?? GUILD_ID },
    isDMBased: vi.fn(() => false),
    permissionsFor: vi.fn((_subject?: unknown) => ({
      has: vi.fn((_permission?: bigint) => options.permissions ?? true),
    })),
  };
}

function role(
  id: string,
  options: { guildId?: string; managed?: boolean; name?: string } = {},
) {
  return {
    id,
    name: options.name ?? `role-${id.slice(-3)}`,
    guild: { id: options.guildId ?? GUILD_ID },
    managed: options.managed ?? false,
  };
}

function replyPayload(harness: Harness): {
  content: string;
  allowedMentions: { parse: unknown[] };
} {
  return vi.mocked(harness.interaction.editReply).mock.calls.at(-1)![0] as {
    content: string;
    allowedMentions: { parse: unknown[] };
  };
}

describe("ticket department commands", () => {
  it("lists tenant departments with bounded fields and mention-safe output", async () => {
    const harness = createHarness({
      subcommand: "list",
      departments: [
        department({ displayName: "Help @everyone", enabled: true }),
        department({
          departmentId: "otherDept1",
          slug: "billing",
          displayName: "Billing",
          sortOrder: 1,
        }),
      ],
      fields: [field("subject01", 0)],
    });

    await runTicketDepartmentCommand(harness);

    expect(replyPayload(harness).content).toContain("Configured: 2/10");
    expect(replyPayload(harness).content).toContain("1 custom field");
    expect(replyPayload(harness).allowedMentions).toEqual({ parse: [] });
    expect(harness.storage.listTicketDepartments).toHaveBeenCalledWith({
      limit: 10,
      offset: 0,
    });
  });

  it("creates a disabled department only after freshly verifying bindings", async () => {
    const harness = createHarness({
      subcommand: "create",
      strings: {
        department: "billing",
        name: "Billing",
        description: "Account and payment support.",
        emoji: "💳",
      },
      integers: { sort_order: 2 },
      channels: {
        category: { ...channel(CATEGORY_ID, ChannelType.GuildCategory) },
        log_channel: { ...channel(LOG_CHANNEL_ID, ChannelType.GuildText) },
      },
      roles: { support_role: role(SUPPORT_ROLE_ID) },
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.guild.channels.fetch).toHaveBeenCalledWith(CATEGORY_ID, {
      cache: true,
      force: true,
    });
    expect(harness.guild.roles.fetch).toHaveBeenCalledWith(SUPPORT_ROLE_ID, {
      cache: true,
      force: true,
    });
    expect(harness.storage.createTicketDepartment).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "billing",
        enabled: false,
        bindingsVerifiedAt: null,
        categoryId: CATEGORY_ID,
        logChannelId: LOG_CHANNEL_ID,
        supportRoleId: SUPPORT_ROLE_ID,
      }),
    );
    expect(harness.runtime.invalidate).toHaveBeenCalledOnce();
  });

  it("does not create a department when the runtime changes after awaited verification", async () => {
    const harness = createHarness({
      subcommand: "create",
      strings: {
        department: "billing",
        name: "Billing",
        description: "Account and payment support.",
      },
      channels: {
        category: channel(CATEGORY_ID, ChannelType.GuildCategory),
        log_channel: channel(LOG_CHANNEL_ID, ChannelType.GuildText),
      },
      roles: { support_role: role(SUPPORT_ROLE_ID) },
    });
    vi.mocked(harness.runtime.isCurrent)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.createTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toContain(
      "after department configuration was verified",
    );
  });

  it("prevents a configure-only delegate from selecting a support role they hold", async () => {
    const harness = createHarness({
      subcommand: "create",
      strings: {
        department: "billing",
        name: "Billing",
        description: "Account and payment support.",
      },
      channels: {
        category: channel(CATEGORY_ID, ChannelType.GuildCategory),
        log_channel: channel(LOG_CHANNEL_ID, ChannelType.GuildText),
      },
      roles: { support_role: role(SUPPORT_ROLE_ID) },
    });
    harness.actor.roles.cache.set(SUPPORT_ROLE_ID, harness.supportRole);

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.createTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toMatch(
      /tickets\.configure.*ticket-content access/i,
    );
  });

  it("prevents a configure-only delegate from routing transcripts to a channel they can read", async () => {
    const harness = createHarness({
      subcommand: "create",
      actorCanViewLog: true,
      strings: {
        department: "billing",
        name: "Billing",
        description: "Account and payment support.",
      },
      channels: {
        category: channel(CATEGORY_ID, ChannelType.GuildCategory),
        log_channel: channel(LOG_CHANNEL_ID, ChannelType.GuildText),
      },
      roles: { support_role: role(SUPPORT_ROLE_ID) },
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.createTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toMatch(
      /configuration-only.*ticket transcripts/i,
    );
  });

  it("allows a delegate who already holds the unchanged support role to edit metadata", async () => {
    const harness = createHarness({
      subcommand: "edit",
      strings: { name: "Court Support" },
      roles: { support_role: role(SUPPORT_ROLE_ID) },
    });
    harness.actor.roles.cache.set(SUPPORT_ROLE_ID, harness.supportRole);

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.updateTicketDepartment).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      { displayName: "Court Support", supportRoleId: SUPPORT_ROLE_ID },
    );
    expect(replyPayload(harness).content).not.toMatch(/ticket-content access/i);
  });

  it("allows a current Administrator to assign a support role they hold", async () => {
    const harness = createHarness({
      subcommand: "create",
      strings: {
        department: "billing",
        name: "Billing",
        description: "Account and payment support.",
      },
      channels: {
        category: channel(CATEGORY_ID, ChannelType.GuildCategory),
        log_channel: channel(LOG_CHANNEL_ID, ChannelType.GuildText),
      },
      roles: { support_role: role(SUPPORT_ROLE_ID) },
    });
    harness.actor.roles.cache.set(SUPPORT_ROLE_ID, harness.supportRole);
    harness.actor.permissions.has.mockReturnValue(true);

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.createTicketDepartment).toHaveBeenCalledWith(
      expect.objectContaining({ supportRoleId: SUPPORT_ROLE_ID }),
    );
  });

  it("rejects deleted channels and managed support roles before create", async () => {
    const deleted = createHarness({
      subcommand: "create",
      strings: {
        department: "billing",
        name: "Billing",
        description: "Billing support",
      },
      channels: {
        category: channel("77777777777777771", ChannelType.GuildCategory),
        log_channel: channel(LOG_CHANNEL_ID, ChannelType.GuildText),
      },
      roles: { support_role: role(SUPPORT_ROLE_ID) },
    });
    await runTicketDepartmentCommand(deleted);
    expect(deleted.storage.createTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(deleted).content).toMatch(/deleted|freshly verified/i);

    const managed = createHarness({
      subcommand: "create",
      strings: {
        department: "billing",
        name: "Billing",
        description: "Billing support",
      },
      channels: {
        category: channel(CATEGORY_ID, ChannelType.GuildCategory),
        log_channel: channel(LOG_CHANNEL_ID, ChannelType.GuildText),
      },
      roles: { support_role: role(SUPPORT_ROLE_ID, { managed: true }) },
    });
    managed.roles.set(
      SUPPORT_ROLE_ID,
      role(SUPPORT_ROLE_ID, { managed: true }),
    );
    await runTicketDepartmentCommand(managed);
    expect(managed.storage.createTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(managed).content).toMatch(/managed|integration/i);
  });

  it("rejects cross-guild and everyone resources", async () => {
    const crossGuild = createHarness({
      subcommand: "create",
      strings: {
        department: "billing",
        name: "Billing",
        description: "Billing support",
      },
      channels: {
        category: channel(CATEGORY_ID, ChannelType.GuildCategory, {
          guildId: OTHER_GUILD_ID,
        }),
        log_channel: channel(LOG_CHANNEL_ID, ChannelType.GuildText),
      },
      roles: { support_role: role(SUPPORT_ROLE_ID) },
    });
    await runTicketDepartmentCommand(crossGuild);
    expect(crossGuild.storage.createTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(crossGuild).content).toMatch(/this server/i);

    const everyone = createHarness({
      subcommand: "create",
      strings: {
        department: "billing",
        name: "Billing",
        description: "Billing support",
      },
      channels: {
        category: channel(CATEGORY_ID, ChannelType.GuildCategory),
        log_channel: channel(LOG_CHANNEL_ID, ChannelType.GuildText),
      },
      roles: { support_role: role(GUILD_ID) },
    });
    everyone.roles.set(GUILD_ID, role(GUILD_ID));
    await runTicketDepartmentCommand(everyone);
    expect(everyone.storage.createTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(everyone).content).toMatch(/everyone/i);
  });

  it("enforces the ten-department bound", async () => {
    const departments = Array.from({ length: 10 }, (_, index) =>
      department({
        departmentId: `department${index}`,
        slug: `department-${index}`,
        sortOrder: index,
      }),
    );
    const harness = createHarness({
      subcommand: "create",
      departments,
      strings: {
        department: "overflow",
        name: "Overflow",
        description: "Overflow department",
      },
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.createTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toContain("maximum of 10");
  });

  it("disables and clears binding review when routing is edited", async () => {
    const harness = createHarness({
      subcommand: "edit",
      departments: [
        department({ enabled: true, bindingsVerifiedAt: FIXED_NOW }),
      ],
      channels: {
        category: channel(NEW_CATEGORY_ID, ChannelType.GuildCategory),
      },
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.updateTicketDepartment).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      expect.objectContaining({
        categoryId: NEW_CATEGORY_ID,
        enabled: false,
        bindingsVerifiedAt: null,
      }),
    );
    expect(replyPayload(harness).content).toMatch(/disabled.*routing changed/i);
  });

  it("refuses to rotate routing while the department has active tickets", async () => {
    const harness = createHarness({
      subcommand: "edit",
      departments: [
        department({ enabled: true, bindingsVerifiedAt: FIXED_NOW }),
      ],
      channels: {
        category: channel(NEW_CATEGORY_ID, ChannelType.GuildCategory),
      },
    });
    vi.mocked(harness.storage.hasActiveTicketsForDepartment).mockReturnValue(
      true,
    );

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.updateTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toMatch(/every active ticket/i);
  });

  it("rechecks active tickets after the final department snapshot check", async () => {
    const harness = createHarness({
      subcommand: "edit",
      departments: [
        department({ enabled: true, bindingsVerifiedAt: FIXED_NOW }),
      ],
      channels: {
        category: channel(NEW_CATEGORY_ID, ChannelType.GuildCategory),
      },
    });
    vi.mocked(harness.storage.hasActiveTicketsForDepartment).mockImplementation(
      () =>
        vi.mocked(harness.storage.getTicketDepartment).mock.calls.length >= 1,
    );

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.updateTicketDepartment).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toMatch(/every active ticket/i);
  });

  it("preserves verified bindings when a department is locally disabled", async () => {
    const harness = createHarness({
      subcommand: "disable",
      departments: [
        department({ enabled: true, bindingsVerifiedAt: FIXED_NOW }),
      ],
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.setTicketDepartmentEnabled).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      false,
    );
    expect(harness.storage.updateTicketDepartment).not.toHaveBeenCalledWith(
      DEPARTMENT_ID,
      { bindingsVerifiedAt: null },
    );
    expect(harness.departmentMap.get(DEPARTMENT_ID)).toMatchObject({
      enabled: false,
      bindingsVerifiedAt: FIXED_NOW,
    });
  });

  it("does not let a configure-only support member reactivate imported dormant bindings", async () => {
    const harness = createHarness({
      subcommand: "enable",
      departments: [department({ enabled: false, bindingsVerifiedAt: null })],
    });
    harness.actor.roles.cache.set(SUPPORT_ROLE_ID, role(SUPPORT_ROLE_ID));

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.updateTicketDepartment).not.toHaveBeenCalled();
    expect(harness.storage.setTicketDepartmentEnabled).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toContain("cannot select");
  });

  it("keeps enabled state when editing only metadata", async () => {
    const harness = createHarness({
      subcommand: "edit",
      strings: { name: "Court Support" },
      departments: [
        department({ enabled: true, bindingsVerifiedAt: FIXED_NOW }),
      ],
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.updateTicketDepartment).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      { displayName: "Court Support" },
    );
  });

  it("validates permission health before enabling and records verification", async () => {
    const harness = createHarness({ subcommand: "enable" });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.updateTicketDepartment).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      { bindingsVerifiedAt: FIXED_NOW },
    );
    expect(harness.storage.setTicketDepartmentEnabled).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      true,
    );
    expect(replyPayload(harness).content).toMatch(/enabled/i);
  });

  it("refuses enable when Superior lacks category permissions", async () => {
    const harness = createHarness({
      subcommand: "enable",
      categoryPermissions: false,
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.setTicketDepartmentEnabled).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toMatch(
      /needs attention|permission/i,
    );
  });

  it("reports resource health privately without mutating configuration", async () => {
    const harness = createHarness({ subcommand: "health" });

    await runTicketDepartmentCommand(harness);

    expect(replyPayload(harness).content).toContain(
      "Routing resources and Superior permissions are ready.",
    );
    expect(replyPayload(harness).allowedMentions).toEqual({ parse: [] });
    expect(harness.storage.updateTicketDepartment).not.toHaveBeenCalled();
  });

  it("requires disabling before deletion and preserves in-use departments", async () => {
    const enabled = createHarness({
      subcommand: "delete",
      departments: [department({ enabled: true })],
    });
    await runTicketDepartmentCommand(enabled);
    expect(enabled.storage.deleteTicketDepartment).not.toHaveBeenCalled();

    const inUse = createHarness({
      subcommand: "delete",
      deleteStatus: "in-use",
    });
    await runTicketDepartmentCommand(inUse);
    expect(inUse.runtime.invalidate).not.toHaveBeenCalled();
    expect(replyPayload(inUse).content).toMatch(
      /ticket records|cannot be deleted/i,
    );
  });

  it("adds a field at an insertion position and reorders atomically", async () => {
    const harness = createHarness({
      group: "field",
      subcommand: "add",
      strings: {
        field: "details01",
        label: "Details",
        type: "paragraph",
      },
      integers: { position: 1 },
      fields: [field("subject01", 0), field("contact01", 1)],
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.upsertTicketDepartmentField).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      expect.objectContaining({
        fieldId: "details01",
        fieldType: "paragraph",
      }),
    );
    expect(harness.storage.reorderTicketDepartmentFields).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      ["subject01", "details01", "contact01"],
    );
  });

  it("enforces the five-field bound before saving", async () => {
    const harness = createHarness({
      group: "field",
      subcommand: "add",
      strings: { field: "overflow1", label: "Overflow", type: "short" },
      integers: { position: 4 },
      fields: Array.from({ length: 5 }, (_, index) =>
        field(`fieldKey${index}`, index),
      ),
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.upsertTicketDepartmentField).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toContain("maximum of 5");
  });

  it("edits field metadata while preserving omitted values and moves it", async () => {
    const harness = createHarness({
      group: "field",
      subcommand: "edit",
      strings: { field: "details01", label: "Full details" },
      integers: { position: 0 },
      fields: [
        field("subject01", 0),
        field("details01", 1, {
          description: "Existing guidance",
          fieldType: "paragraph",
          maxLength: 2_000,
        }),
      ],
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.upsertTicketDepartmentField).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      expect.objectContaining({
        fieldId: "details01",
        label: "Full details",
        description: "Existing guidance",
        fieldType: "paragraph",
        maxLength: 2_000,
      }),
    );
    expect(harness.storage.reorderTicketDepartmentFields).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      ["details01", "subject01"],
    );
  });

  it("removes and compacts fields, and supports focused move", async () => {
    const remove = createHarness({
      group: "field",
      subcommand: "remove",
      strings: { field: "details01" },
      fields: [
        field("subject01", 0),
        field("details01", 1),
        field("contact01", 2),
      ],
    });
    await runTicketDepartmentCommand(remove);
    expect(remove.storage.removeTicketDepartmentField).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      "details01",
    );
    expect(remove.storage.reorderTicketDepartmentFields).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      ["subject01", "contact01"],
    );

    const move = createHarness({
      group: "field",
      subcommand: "move",
      strings: { field: "contact01" },
      integers: { position: 0 },
      fields: [field("subject01", 0), field("contact01", 1)],
    });
    await runTicketDepartmentCommand(move);
    expect(move.storage.reorderTicketDepartmentFields).toHaveBeenCalledWith(
      DEPARTMENT_ID,
      ["contact01", "subject01"],
    );
  });

  it("fails closed when the runtime changes before a mutation", async () => {
    const harness = createHarness({
      subcommand: "disable",
      current: false,
      departments: [department({ enabled: true })],
    });

    await runTicketDepartmentCommand(harness);

    expect(harness.storage.setTicketDepartmentEnabled).not.toHaveBeenCalled();
    expect(replyPayload(harness).content).toMatch(/server changed/i);
  });
});
