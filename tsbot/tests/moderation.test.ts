import { Collection, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import {
  formatPurgeResult,
  handleModerationCommand,
} from "../src/discord/moderation.js";

const GUILD_ID = "123456789012345678";
const USER_ID = "223456789012345678";

function createHarness(
  options: {
    messages?: Array<{
      id: string;
      authorId?: string;
      createdTimestamp: number;
    }>;
    permissions?: bigint[];
    selectedGuildId?: string;
    current?: boolean;
    fetchFailure?: boolean;
    deleteFailure?: boolean;
    subcommand?: string;
    scanLimit?: number;
    deleteLimit?: number;
    targetId?: string;
  } = {},
) {
  let current = options.current ?? true;
  const permissions = options.permissions ?? [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageMessages,
  ];
  const fetched = new Collection(
    (options.messages ?? []).map((message) => [
      message.id,
      {
        id: message.id,
        author: { id: message.authorId ?? USER_ID },
        createdTimestamp: message.createdTimestamp,
      },
    ]),
  );
  const fetch = options.fetchFailure
    ? vi.fn(async () => {
        throw new Error("synthetic fetch failure");
      })
    : vi.fn(async () => fetched);
  const bulkDelete = options.deleteFailure
    ? vi.fn(async () => {
        throw new Error("synthetic delete failure");
      })
    : vi.fn(async (input: Collection<string, unknown> | unknown[]) => {
        const values =
          input instanceof Collection ? [...input.values()] : input;
        return new Collection(
          values.map((message) => [(message as { id: string }).id, message]),
        );
      });
  const channel = {
    id: "333333333333333333",
    guild: {
      id: options.selectedGuildId ?? GUILD_ID,
      channels: { fetch: vi.fn() },
    },
    isDMBased: vi.fn(() => false),
    isTextBased: vi.fn(() => true),
    messages: { fetch },
    bulkDelete,
    permissionsFor: vi.fn(() => ({
      has: (permission: bigint) => permissions.includes(permission),
    })),
  };
  const reply = vi.fn(async () => undefined);
  let interaction!: Record<string, unknown>;
  const deferReply = vi.fn(async () => {
    interaction.deferred = true;
  });
  const editReply = vi.fn(async () => undefined);
  const recordCommandMetric = vi.fn();
  interaction = {
    guildId: GUILD_ID,
    guild: {
      id: GUILD_ID,
      members: {
        fetchMe: vi.fn(async () => ({ id: "bot", guild: { id: GUILD_ID } })),
      },
    },
    channel,
    user: { id: USER_ID, tag: "member_name" },
    options: {
      getSubcommand: vi.fn(() => options.subcommand ?? "purge"),
      getInteger: vi.fn((name: string) => {
        if (name === "amount") return 10;
        if (name === "scan_limit") return options.scanLimit ?? 200;
        if (name === "delete_limit") return options.deleteLimit ?? 100;
        return null;
      }),
      getChannel: vi.fn(() => channel),
      getUser: vi.fn(() => ({
        id: options.targetId ?? USER_ID,
        tag: "member_name",
      })),
    },
    deferred: false,
    replied: false,
    reply,
    deferReply,
    editReply,
  };
  const runtime = {
    guildId: GUILD_ID,
    settings: {
      channels: { log: null },
      limits: { bulkModerationTargetCap: 100 },
    },
    storage: { recordCommandMetric },
    isCurrent: vi.fn(() => current),
  } as unknown as GuildRuntime;
  return {
    interaction,
    runtime,
    channel,
    fetch,
    bulkDelete,
    reply,
    deferReply,
    editReply,
    recordCommandMetric,
    setCurrent(value: boolean) {
      current = value;
    },
  };
}

describe("purge accounting", () => {
  it("formats requested, scanned, deleted, age, and API counts explicitly", () => {
    expect(
      formatPurgeResult({
        requested: 12,
        scanned: 10,
        deleted: 6,
        old: 3,
        apiSkipped: 1,
      }),
    ).toContain("Requested: **12**");
    expect(
      formatPurgeResult({
        requested: 12,
        scanned: 10,
        deleted: 6,
        old: 3,
        apiSkipped: 1,
      }),
    ).toContain("Skipped (older than 14 days): **3**");
  });

  it("preflights all three bot permissions before fetching history", async () => {
    const harness = createHarness({
      permissions: [PermissionFlagsBits.ViewChannel],
    });

    await handleModerationCommand(
      harness.interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Read Message History"),
      }),
    );
    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.bulkDelete).not.toHaveBeenCalled();
  });

  it("rejects a cross-guild channel before fetching or mutating", async () => {
    const harness = createHarness({ selectedGuildId: "999999999999999999" });

    await handleModerationCommand(
      harness.interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.fetch).not.toHaveBeenCalled();
    expect(harness.bulkDelete).not.toHaveBeenCalled();
  });

  it("filters messages older than 14 days and reports the actual API result", async () => {
    const now = Date.now();
    const harness = createHarness({
      messages: [
        { id: "1", createdTimestamp: now - 60_000 },
        { id: "2", createdTimestamp: now - 120_000 },
        { id: "3", createdTimestamp: now - 15 * 86_400_000 },
      ],
    });

    await handleModerationCommand(
      harness.interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.deferReply).toHaveBeenCalledWith({
      flags: MessageFlags.Ephemeral,
    });
    expect(harness.bulkDelete).toHaveBeenCalledTimes(1);
    const deletionInput = harness.bulkDelete.mock.calls[0]?.[0] as Collection<
      string,
      unknown
    >;
    expect(deletionInput.size).toBe(2);
    expect(harness.editReply).toHaveBeenCalledWith(
      expect.stringMatching(
        /Scanned: \*\*3\*\*[\s\S]*Deleted: \*\*2\*\*[\s\S]*14 days\): \*\*1\*\*/,
      ),
    );
    expect(harness.recordCommandMetric).toHaveBeenCalledWith(
      "superior.purge",
      true,
    );
  });

  it("reports a fetch failure without claiming deletion or recording success", async () => {
    const harness = createHarness({ fetchFailure: true });

    await handleModerationCommand(
      harness.interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.bulkDelete).not.toHaveBeenCalled();
    expect(harness.editReply).toHaveBeenCalledWith(
      expect.stringContaining("nothing was deleted"),
    );
    expect(harness.recordCommandMetric).not.toHaveBeenCalled();
  });

  it("cancels before mutation when the guild runtime becomes stale", async () => {
    const harness = createHarness({
      messages: [{ id: "1", createdTimestamp: Date.now() }],
    });
    harness.fetch.mockImplementationOnce(async () => {
      harness.setCurrent(false);
      return new Collection();
    });

    await handleModerationCommand(
      harness.interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.bulkDelete).not.toHaveBeenCalled();
    expect(harness.editReply).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
    );
  });
});

describe("purge-user accounting", () => {
  function page(
    count: number,
    options: {
      targetId?: string;
      otherId?: string;
      targetCount?: number;
      createdTimestamp?: number;
      offset?: number;
    } = {},
  ): Collection<string, never> {
    const targetCount = options.targetCount ?? count;
    return new Collection(
      Array.from({ length: count }, (_, index) => {
        const id = String((options.offset ?? 0) + index + 1);
        return [
          id,
          {
            id,
            author: {
              id:
                index < targetCount
                  ? (options.targetId ?? USER_ID)
                  : (options.otherId ?? "323456789012345678"),
            },
            createdTimestamp: options.createdTimestamp ?? Date.now(),
          } as never,
        ];
      }),
    );
  }

  it("paginates to the scan bound and enforces the independent delete cap", async () => {
    const harness = createHarness({
      subcommand: "purgeuser",
      scanLimit: 150,
      deleteLimit: 2,
    });
    harness.fetch
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(3, { offset: 100 }));

    await handleModerationCommand(
      harness.interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.fetch).toHaveBeenCalledTimes(2);
    expect(harness.bulkDelete).toHaveBeenCalledTimes(1);
    expect((harness.bulkDelete.mock.calls[0]?.[0] as unknown[]).length).toBe(2);
    expect(harness.editReply).toHaveBeenCalledWith(
      expect.stringMatching(
        /Scanned: \*\*103\/150\*\*[\s\S]*Matched: \*\*103\*\*[\s\S]*Deleted: \*\*2\*\*[\s\S]*delete cap\): \*\*101\*\*/,
      ),
    );
  });

  it("reports a partial history-fetch failure while preserving actual deletions", async () => {
    const harness = createHarness({
      subcommand: "purgeuser",
      scanLimit: 150,
      deleteLimit: 10,
    });
    harness.fetch
      .mockResolvedValueOnce(page(100, { targetCount: 1 }))
      .mockRejectedValueOnce(new Error("synthetic second-page failure"));

    await handleModerationCommand(
      harness.interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.bulkDelete).toHaveBeenCalledTimes(1);
    expect(harness.editReply).toHaveBeenCalledWith(
      expect.stringMatching(/Deleted: \*\*1\*\*[\s\S]*History fetch stopped/),
    );
    expect(harness.recordCommandMetric).toHaveBeenCalledWith(
      "superior.purgeuser",
      false,
    );
  });

  it("reports old matches and an API deletion failure without claiming success", async () => {
    const harness = createHarness({
      subcommand: "purgeuser",
      deleteFailure: true,
      messages: [
        { id: "recent", createdTimestamp: Date.now() },
        { id: "old", createdTimestamp: Date.now() - 15 * 86_400_000 },
      ],
    });

    await handleModerationCommand(
      harness.interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.editReply).toHaveBeenCalledWith(
      expect.stringMatching(
        /Deleted: \*\*0\*\*[\s\S]*14 days\): \*\*1\*\*[\s\S]*rejected the delete request/,
      ),
    );
    expect(harness.recordCommandMetric).toHaveBeenCalledWith(
      "superior.purgeuser",
      false,
    );
  });

  it("cancels before deletion when the runtime changes during pagination", async () => {
    const harness = createHarness({ subcommand: "purgeuser" });
    harness.fetch.mockImplementationOnce(async () => {
      harness.setCurrent(false);
      return page(1);
    });

    await handleModerationCommand(
      harness.interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.bulkDelete).not.toHaveBeenCalled();
    expect(harness.editReply).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
    );
  });
});

describe("channel and timeout safety", () => {
  function createLockHarness(channelId: string) {
    let allow = 0n;
    let deny = 0n;
    const overwrite = {
      allow: {
        get bitfield() {
          return allow;
        },
        has: (permission: bigint) => (allow & permission) === permission,
      },
      deny: {
        get bitfield() {
          return deny;
        },
        has: (permission: bigint) => (deny & permission) === permission,
      },
    };
    const edit = vi.fn(
      async (_role: unknown, change: { SendMessages: boolean | null }) => {
        if (change.SendMessages === false) {
          allow &= ~PermissionFlagsBits.SendMessages;
          deny |= PermissionFlagsBits.SendMessages;
        } else {
          allow &= ~PermissionFlagsBits.SendMessages;
          deny &= ~PermissionFlagsBits.SendMessages;
        }
      },
    );
    const everyone = { id: GUILD_ID };
    const channel = {
      id: channelId,
      guild: { id: GUILD_ID, channels: { fetch: vi.fn() } },
      isDMBased: vi.fn(() => false),
      isTextBased: vi.fn(() => true),
      isThread: vi.fn(() => false),
      messages: {},
      permissionsFor: vi.fn(() => ({
        has: (permission: bigint) =>
          permission === PermissionFlagsBits.ManageChannels,
      })),
      permissionOverwrites: {
        cache: new Map([[everyone.id, overwrite]]),
        edit,
      },
    };
    const runtime = {
      guildId: GUILD_ID,
      settings: { channels: { log: null } },
      isCurrent: vi.fn(() => true),
      storage: {
        recordCommandMetric: vi.fn(),
        getModerationConfiguration: vi.fn(() => ({
          guildId: GUILD_ID,
          casesEnabled: true,
        })),
      },
    } as unknown as GuildRuntime;
    const makeInteraction = (subcommand: "lock" | "unlock") => {
      const interaction: Record<string, unknown> = {
        guildId: GUILD_ID,
        guild: {
          id: GUILD_ID,
          roles: { everyone },
          members: {
            fetchMe: vi.fn(async () => ({
              id: "bot",
              guild: { id: GUILD_ID },
            })),
          },
        },
        channel,
        user: { id: USER_ID },
        options: {
          getSubcommand: vi.fn(() => subcommand),
          getChannel: vi.fn(() => channel),
          getString: vi.fn(() => null),
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
    };
    return { runtime, edit, makeInteraction, getDeny: () => deny };
  }

  it("refuses to clear an untracked channel deny", async () => {
    const harness = createLockHarness("423456789012345678");
    const interaction = harness.makeInteraction("unlock");

    await handleModerationCommand(
      interaction as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.edit).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("cannot prove"),
      }),
    );
  });

  it("unlocks only the unchanged deny tracked by the running process", async () => {
    const harness = createLockHarness("523456789012345678");

    await handleModerationCommand(
      harness.makeInteraction("lock") as never,
      harness.runtime,
      {} as never,
    );
    await handleModerationCommand(
      harness.makeInteraction("unlock") as never,
      harness.runtime,
      {} as never,
    );

    expect(harness.edit).toHaveBeenCalledTimes(2);
    expect(harness.getDeny()).toBe(0n);
  });

  it("does not count an already-active member as newly unmuted", async () => {
    const timeout = vi.fn(async () => undefined);
    const role = { comparePositionTo: vi.fn(() => 1) };
    const actor = {
      id: USER_ID,
      guild: { id: GUILD_ID },
      roles: { highest: role },
    };
    const target = {
      id: "623456789012345678",
      guild: { id: GUILD_ID, ownerId: "923456789012345678" },
      roles: { highest: {} },
      moderatable: true,
      isCommunicationDisabled: vi.fn(() => false),
      timeout,
    };
    const bot = { id: "bot", guild: { id: GUILD_ID } };
    const interaction: Record<string, unknown> = {
      guildId: GUILD_ID,
      guild: {
        id: GUILD_ID,
        members: {
          fetchMe: vi.fn(async () => bot),
          fetch: vi.fn(async () => target),
        },
      },
      user: { id: USER_ID },
      options: {
        getSubcommand: vi.fn(() => "untimeout"),
        getUser: vi.fn(() => ({ id: target.id })),
        getString: vi.fn(() => null),
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
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: vi.fn(() => true),
      storage: {
        recordCommandMetric: vi.fn(),
        getModerationConfiguration: vi.fn(() => ({
          guildId: GUILD_ID,
          casesEnabled: true,
        })),
      },
    } as unknown as GuildRuntime;

    await handleModerationCommand(
      interaction as never,
      runtime,
      actor as never,
    );

    expect(timeout).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("not currently timed out"),
      }),
    );
  });

  it("records a timeout case only after Discord confirms the action", async () => {
    let timedOut = false;
    const timeout = vi.fn(async () => {
      timedOut = true;
    });
    const reservedCase = {
      caseId: "case_token",
      caseNumber: 12,
      actionType: "timeout",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    const reserveModerationCaseAttempt = vi.fn(() => reservedCase);
    const confirmModerationCase = vi.fn(() => ({
      status: "changed",
      case: { ...reservedCase, status: "active" },
    }));
    const actor = {
      id: USER_ID,
      guild: { id: GUILD_ID, ownerId: USER_ID },
      roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
      permissions: { has: vi.fn(() => true) },
    };
    const target = {
      id: "623456789012345678",
      displayName: "Target Member",
      guild: { id: GUILD_ID, ownerId: "923456789012345678" },
      roles: { highest: {} },
      moderatable: true,
      isCommunicationDisabled: vi.fn(() => timedOut),
      communicationDisabledUntil: new Date("2026-08-13T00:15:00.000Z"),
      timeout,
    };
    const bot = { id: "323456789012345678", guild: { id: GUILD_ID } };
    const interaction: Record<string, unknown> = {
      guildId: GUILD_ID,
      guild: {
        id: GUILD_ID,
        ownerId: USER_ID,
        members: {
          fetchMe: vi.fn(async () => bot),
          fetch: vi.fn(async (input: string | { user: string }) =>
            (typeof input === "string" ? input : input.user) === USER_ID
              ? actor
              : target,
          ),
        },
      },
      user: { id: USER_ID },
      options: {
        getSubcommand: vi.fn(() => "timeout"),
        getUser: vi.fn(() => ({ id: target.id })),
        getInteger: vi.fn(() => 15),
        getString: vi.fn(() => "Repeated disruption"),
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
    const runtime = {
      guildId: GUILD_ID,
      isCurrent: vi.fn(() => true),
      storage: {
        recordCommandMetric: vi.fn(),
        getModerationConfiguration: vi.fn(() => ({
          guildId: GUILD_ID,
          casesEnabled: true,
        })),
        reserveModerationCaseAttempt,
        confirmModerationCase,
        failModerationCaseAttempt: vi.fn(),
        listModerationCases: vi.fn(() => []),
        findUniqueActiveModerationCase: vi.fn(() => ({
          status: "none",
          case: null,
        })),
      },
    } as unknown as GuildRuntime;

    await handleModerationCommand(
      interaction as never,
      runtime,
      actor as never,
    );

    expect(timeout).toHaveBeenCalledWith(15 * 60_000, "Repeated disruption");
    expect(reserveModerationCaseAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: target.id,
        actorId: USER_ID,
        actionType: "timeout",
        source: "superior-command",
        publicReason: "Repeated disruption",
      }),
    );
    expect(
      reserveModerationCaseAttempt.mock.invocationCallOrder[0],
    ).toBeLessThan(timeout.mock.invocationCallOrder[0]!);
    expect(timeout.mock.invocationCallOrder[0]).toBeLessThan(
      confirmModerationCase.mock.invocationCallOrder[0]!,
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Case **#12** was recorded"),
      }),
    );
  });

  it("stops a bulk timeout between members when configuration changes", async () => {
    let current = true;
    const firstTimeout = vi.fn(async () => {
      current = false;
    });
    const secondTimeout = vi.fn(async () => undefined);
    const targetIds = ["723456789012345678", "823456789012345678"];
    const makeTarget = (id: string, timeout: typeof firstTimeout) => ({
      id,
      guild: { id: GUILD_ID, ownerId: "923456789012345678" },
      roles: { highest: {} },
      moderatable: true,
      isCommunicationDisabled: vi.fn(() => false),
      timeout,
    });
    const targets = new Map([
      [targetIds[0], makeTarget(targetIds[0]!, firstTimeout)],
      [targetIds[1], makeTarget(targetIds[1]!, secondTimeout)],
    ]);
    const actor = {
      id: USER_ID,
      guild: { id: GUILD_ID, ownerId: USER_ID },
      roles: { highest: { comparePositionTo: vi.fn(() => 1) } },
      permissions: { has: vi.fn(() => true) },
    };
    const bot = {
      id: "bot",
      guild: { id: GUILD_ID },
      permissions: {
        has: (permission: bigint) =>
          permission === PermissionFlagsBits.ModerateMembers,
      },
    };
    const interaction: Record<string, unknown> = {
      guildId: GUILD_ID,
      guild: {
        id: GUILD_ID,
        ownerId: USER_ID,
        members: {
          fetchMe: vi.fn(async () => bot),
          fetch: vi.fn(async (input: string | { user: string }) => {
            const id = typeof input === "string" ? input : input.user;
            return id === USER_ID ? actor : (targets.get(id) ?? null);
          }),
        },
      },
      user: { id: USER_ID },
      options: {
        getSubcommand: vi.fn(() => "mutemany"),
        getString: vi.fn((name: string) =>
          name === "members" ? targetIds.join(" ") : null,
        ),
        getBoolean: vi.fn(() => false),
        getInteger: vi.fn(() => 10),
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
    const recordCommandMetric = vi.fn();
    const runtime = {
      guildId: GUILD_ID,
      settings: { limits: { bulkModerationTargetCap: 100 } },
      isCurrent: vi.fn(() => current),
      storage: {
        recordCommandMetric,
        getModerationConfiguration: vi.fn(() => ({
          guildId: GUILD_ID,
          casesEnabled: true,
        })),
        reserveModerationCaseAttempt: vi.fn(() => ({
          caseId: "case_token",
          caseNumber: 12,
          actionType: "timeout",
          updatedAt: "2026-08-13T00:00:00.000Z",
        })),
        confirmModerationCase: vi.fn(() => ({
          status: "changed",
          case: { caseId: "case_token", caseNumber: 12, actionType: "timeout" },
        })),
        failModerationCaseAttempt: vi.fn(),
        listModerationCases: vi.fn(() => []),
        findUniqueActiveModerationCase: vi.fn(() => ({
          status: "none",
          case: null,
        })),
      },
    } as unknown as GuildRuntime;

    await handleModerationCommand(
      interaction as never,
      runtime,
      actor as never,
    );

    expect(firstTimeout).toHaveBeenCalledTimes(1);
    expect(secondTimeout).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("**1 cancelled after reconfiguration**"),
    );
    expect(recordCommandMetric).not.toHaveBeenCalled();
  });

  it.each([null, { guildId: GUILD_ID, casesEnabled: false }])(
    "fails closed before a legacy member timeout when case actions are disabled (%j)",
    async (configuration) => {
      const targetFetch = vi.fn();
      const timeout = vi.fn();
      const reserveModerationCaseAttempt = vi.fn();
      const interaction: Record<string, unknown> = {
        guildId: GUILD_ID,
        guild: {
          id: GUILD_ID,
          members: { fetch: targetFetch, fetchMe: vi.fn() },
        },
        user: { id: USER_ID },
        options: { getSubcommand: vi.fn(() => "timeout") },
        deferred: false,
        replied: false,
        editReply: vi.fn(async () => undefined),
        reply: vi.fn(async () => undefined),
        followUp: vi.fn(async () => undefined),
      };
      interaction.deferReply = vi.fn(async () => {
        interaction.deferred = true;
      });
      const runtime = {
        guildId: GUILD_ID,
        storage: {
          getModerationConfiguration: vi.fn(() => configuration),
          reserveModerationCaseAttempt,
          recordCommandMetric: vi.fn(),
        },
      } as unknown as GuildRuntime;

      await handleModerationCommand(interaction as never, runtime, {
        timeout,
      } as never);

      expect(targetFetch).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
      expect(reserveModerationCaseAttempt).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(
            "No member timeout action was taken",
          ),
        }),
      );
    },
  );
});
