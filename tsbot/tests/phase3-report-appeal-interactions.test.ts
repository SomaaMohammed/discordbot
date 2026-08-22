import {
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildMember,
  type Message,
  type Role,
  type TextChannel,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { GuildRuntime } from "../src/runtime.js";
import type {
  CaseAppeal,
  MemberReport,
  ModerationCase,
  ModerationConfiguration,
} from "../src/types.js";
import {
  APPEAL_DECISION_REASON_FIELD_ID,
  APPEAL_EXPLANATION_FIELD_ID,
  appealVersionToken,
  buildAppealControlRow,
  createAppealDecisionModal,
  createAppealSubmitModal,
} from "../src/discord/appeal-components.js";
import {
  handleAppealButton,
  handleAppealModal,
} from "../src/discord/appeal-interactions.js";
import { handleAppealCommand } from "../src/discord/appeal-commands-handler.js";
import {
  REPORT_CATEGORY_FIELD_ID,
  REPORT_DECISION_REASON_FIELD_ID,
  REPORT_EVIDENCE_FIELD_ID,
  REPORT_EXPLANATION_FIELD_ID,
  REPORT_LINKED_CASE_FIELD_ID,
  buildReportControlRow,
  createReportDecisionModal,
  createReportSubmitModal,
  reportVersionToken,
} from "../src/discord/report-components.js";
import {
  handleReportButton,
  handleReportModal,
} from "../src/discord/report-interactions.js";
import { handleReportCommand } from "../src/discord/report-commands-handler.js";

const GUILD_ID = "111111111111111111";
const OTHER_GUILD_ID = "121212121212121212";
const BOT_ID = "222222222222222222";
const REVIEWER_ID = "333333333333333333";
const REPORTER_ID = "444444444444444444";
const TARGET_ID = "555555555555555555";
const REVIEWER_ROLE_ID = "666666666666666666";
const REVIEW_CHANNEL_ID = "777777777777777777";
const REVIEW_MESSAGE_ID = "888888888888888888";
const STALE_REVIEW_MESSAGE_ID = "898989898989898989";
const PRIOR_REVIEWER_ID = "999999999999999999";
const EVIDENCE_CHANNEL_ID = "101010101010101010";
const EVIDENCE_MESSAGE_ID = "202020202020202020";
const OUTSIDE_MEMBER_ID = "303030303030303030";
const T0 = "2026-08-21T00:00:00.000Z";
const T1 = "2026-08-21T00:01:00.000Z";
const PRIVATE_DECISION = "private-decision-reason-sentinel";
const PRIVATE_APPEAL = "private-appeal-explanation-sentinel";
const PRIVATE_CASE_NOTE = "private-case-note-sentinel";

function configuration(
  overrides: Partial<ModerationConfiguration> = {},
): ModerationConfiguration {
  return {
    guildId: GUILD_ID,
    casesEnabled: true,
    moderationLogChannelId: null,
    moderationLogVerifiedAt: null,
    reportsEnabled: true,
    reportReviewChannelId: REVIEW_CHANNEL_ID,
    reportReviewerRoleId: REVIEWER_ROLE_ID,
    reportBindingsVerifiedAt: T0,
    appealsEnabled: true,
    appealReviewChannelId: REVIEW_CHANNEL_ID,
    appealReviewerRoleId: REVIEWER_ROLE_ID,
    appealBindingsVerifiedAt: T0,
    antiSpamEnabled: false,
    reportCooldownLimit: 3,
    reportCooldownWindowSeconds: 1_800,
    createdBy: REVIEWER_ID,
    updatedBy: REVIEWER_ID,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function memberReport(overrides: Partial<MemberReport> = {}): MemberReport {
  return {
    guildId: GUILD_ID,
    reportId: "report_token_123",
    reportNumber: 7,
    reporterId: REPORTER_ID,
    targetUserId: TARGET_ID,
    category: "safety",
    explanation: "A sufficiently detailed private report explanation.",
    evidenceGuildId: null,
    evidenceChannelId: null,
    evidenceMessageId: null,
    state: "submitted",
    deliveryState: "posted",
    reviewChannelId: REVIEW_CHANNEL_ID,
    reviewMessageId: REVIEW_MESSAGE_ID,
    claimedBy: null,
    claimedAt: null,
    decisionBy: null,
    decisionReason: null,
    decidedAt: null,
    linkedCaseId: null,
    withdrawnAt: null,
    failureCode: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function caseAppeal(overrides: Partial<CaseAppeal> = {}): CaseAppeal {
  return {
    guildId: GUILD_ID,
    appealId: "appeal_token_123",
    appealNumber: 9,
    caseId: "case_token_123",
    appellantId: TARGET_ID,
    explanation: PRIVATE_APPEAL,
    state: "submitted",
    deliveryState: "posted",
    reviewChannelId: REVIEW_CHANNEL_ID,
    reviewMessageId: REVIEW_MESSAGE_ID,
    claimedBy: null,
    claimedAt: null,
    decisionBy: null,
    decisionReason: null,
    decidedAt: null,
    reversalCaseId: null,
    withdrawnAt: null,
    failureCode: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function moderationCase(
  overrides: Partial<ModerationCase> = {},
): ModerationCase {
  return {
    guildId: GUILD_ID,
    caseId: "case_token_123",
    caseNumber: 42,
    targetUserId: TARGET_ID,
    actorId: REVIEWER_ID,
    actionType: "warning",
    source: "moderation-command",
    publicReason: "Public moderation reason.",
    privateNote: PRIVATE_CASE_NOTE,
    discordActionMetadata: {},
    status: "active",
    relatedCaseId: null,
    voidedBy: null,
    voidedAt: null,
    voidReason: null,
    overturnedBy: null,
    overturnedAt: null,
    overturnReason: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

interface GuildHarnessOptions {
  guildId?: string;
  priorStatus?: "absent" | "authorized" | "unauthorized" | "unavailable";
  targetTimedOut?: boolean;
  timeoutRejects?: boolean;
  activeBan?: boolean;
}

function guildHarness(options: GuildHarnessOptions = {}) {
  const guildId = options.guildId ?? GUILD_ID;
  const guild = {
    id: guildId,
    ownerId: REVIEWER_ID,
  } as unknown as Guild;
  const reviewerRole = {
    id: REVIEWER_ROLE_ID,
    guild,
    managed: false,
  } as unknown as Role;
  const everyoneRole = {
    id: guildId,
    guild,
    managed: false,
  } as unknown as Role;
  const fullChannelAccess = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ]);
  const botPermissions = new PermissionsBitField([
    ...fullChannelAccess.toArray(),
    PermissionFlagsBits.ModerateMembers,
  ]);
  const targetTimeout = options.timeoutRejects
    ? vi.fn(async () => {
        throw new Error("Discord timeout removal failed");
      })
    : vi.fn(async () => undefined);
  const makeMember = (
    id: string,
    memberOptions: {
      bot?: boolean;
      reviewerRole?: boolean;
      permissions?: PermissionsBitField;
    } = {},
  ) =>
    ({
      id,
      guild,
      displayName: `member-${id}`,
      user: { id, bot: memberOptions.bot ?? false },
      permissions: memberOptions.permissions ?? new PermissionsBitField(),
      roles: {
        cache: new Collection(
          memberOptions.reviewerRole ? [[REVIEWER_ROLE_ID, reviewerRole]] : [],
        ),
        highest: { comparePositionTo: vi.fn(() => 1) },
      },
      moderatable: true,
      communicationDisabledUntil: options.targetTimedOut
        ? new Date("2026-08-21T01:00:00.000Z")
        : null,
      isCommunicationDisabled: vi.fn(() => options.targetTimedOut ?? false),
      timeout: targetTimeout,
    }) as unknown as GuildMember;
  const reviewer = makeMember(REVIEWER_ID);
  const reporter = makeMember(REPORTER_ID);
  const target = makeMember(TARGET_ID);
  const prior = makeMember(PRIOR_REVIEWER_ID, {
    reviewerRole: options.priorStatus === "authorized",
  });
  const bot = makeMember(BOT_ID, { bot: true, permissions: botPermissions });
  const dmSend = vi.fn(async () => undefined);
  const userFetch = vi.fn(async (id: string) => ({
    id,
    bot: false,
    send: dmSend,
  }));
  const reviewMessage = {
    id: REVIEW_MESSAGE_ID,
    channelId: REVIEW_CHANNEL_ID,
    guild,
    author: { id: BOT_ID, bot: true },
    edit: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as Message;
  const reviewChannel = {
    id: REVIEW_CHANNEL_ID,
    type: ChannelType.GuildText,
    guild,
    permissionOverwrites: { cache: new Collection() },
    permissionsFor: vi.fn((subject: { id: string }) =>
      subject.id === guildId ? new PermissionsBitField() : fullChannelAccess,
    ),
    messages: { fetch: vi.fn(async () => reviewMessage) },
    send: vi.fn(async () => reviewMessage),
  } as unknown as TextChannel;
  const channelsFetch = vi.fn(async (id: string) =>
    id === REVIEW_CHANNEL_ID ? reviewChannel : null,
  );
  const members = new Map<string, GuildMember>([
    [REVIEWER_ID, reviewer],
    [REPORTER_ID, reporter],
    [TARGET_ID, target],
    [PRIOR_REVIEWER_ID, prior],
    [BOT_ID, bot],
  ]);
  const membersFetch = vi.fn(
    async (input: string | { user: string }): Promise<GuildMember> => {
      const id = typeof input === "string" ? input : input.user;
      if (id === PRIOR_REVIEWER_ID && options.priorStatus === "absent") {
        throw Object.assign(new Error("Unknown Member"), { code: 10_007 });
      }
      if (id === PRIOR_REVIEWER_ID && options.priorStatus === "unavailable") {
        throw new Error("Discord lookup unavailable");
      }
      const found = members.get(id);
      if (!found) {
        throw Object.assign(new Error("Unknown Member"), { code: 10_007 });
      }
      return found;
    },
  );
  const banFetch = vi.fn(async () => {
    if (options.activeBan) return { user: { id: TARGET_ID } };
    throw Object.assign(new Error("Unknown Ban"), { code: 10_026 });
  });
  Object.assign(guild, {
    client: { user: { id: BOT_ID }, users: { fetch: userFetch } },
    channels: { fetch: channelsFetch },
    roles: {
      everyone: everyoneRole,
      fetch: vi.fn(async (id: string) =>
        id === REVIEWER_ROLE_ID ? reviewerRole : null,
      ),
    },
    members: {
      fetch: membersFetch,
      fetchMe: vi.fn(async () => bot),
    },
    bans: { fetch: banFetch },
  });
  return {
    guild,
    reviewer,
    reporter,
    target,
    prior,
    bot,
    reviewChannel,
    reviewMessage,
    channelsFetch,
    membersFetch,
    targetTimeout,
    userFetch,
    dmSend,
    banFetch,
  };
}

function storageHarness(
  input: {
    config?: ModerationConfiguration;
    report?: MemberReport | null;
    appeal?: CaseAppeal | null;
    moderationCase?: ModerationCase | null;
  } = {},
) {
  const state: {
    config: ModerationConfiguration;
    report: MemberReport | null;
    appeal: CaseAppeal | null;
    moderationCase: ModerationCase | null;
  } = {
    config: input.config ?? configuration(),
    report: input.report ?? null,
    appeal: input.appeal ?? null,
    moderationCase: input.moderationCase ?? null,
  };
  const storage = {
    getModerationConfiguration: vi.fn(() => state.config),
    listCapabilityGrantsForCapability: vi.fn(() => []),
    listCapabilitiesForRoles: vi.fn(() => []),
    recordCommandMetric: vi.fn(),
    findPostedPanelByToken: vi.fn(() => null),

    reserveMemberReport: vi.fn(),
    getMemberReportById: vi.fn(() => state.report),
    getMemberReportByNumber: vi.fn(() => state.report),
    listMemberReports: vi.fn(() => (state.report ? [state.report] : [])),
    claimMemberReport: vi.fn(),
    takeOverMemberReportClaim: vi.fn(),
    releaseMemberReportClaim: vi.fn(),
    decideMemberReport: vi.fn(),
    withdrawMemberReport: vi.fn(),
    claimMemberReportDelivery: vi.fn(),
    getMemberReportDeliveryAttempt: vi.fn(() => null),
    beginMemberReportDeliveryAttempt: vi.fn(() => ({
      status: "changed",
      record: state.report,
      attempt: {
        attemptId: "report_delivery_attempt_123",
        channelId: REVIEW_CHANNEL_ID,
        startedAt: T0,
      },
    })),
    bindMemberReportDelivery: vi.fn(),
    failMemberReportDelivery: vi.fn(),
    markMemberReportDeliveryMissing: vi.fn(),

    reserveCaseAppeal: vi.fn(),
    getCaseAppealById: vi.fn(() => state.appeal),
    getCaseAppealByNumber: vi.fn(() => state.appeal),
    listCaseAppeals: vi.fn(() => (state.appeal ? [state.appeal] : [])),
    claimCaseAppeal: vi.fn(),
    takeOverCaseAppealClaim: vi.fn(),
    releaseCaseAppealClaim: vi.fn(),
    decideCaseAppeal: vi.fn(),
    withdrawCaseAppeal: vi.fn(),
    claimCaseAppealDelivery: vi.fn(),
    getCaseAppealDeliveryAttempt: vi.fn(() => null),
    beginCaseAppealDeliveryAttempt: vi.fn(() => ({
      status: "changed",
      record: state.appeal,
      attempt: {
        attemptId: "appeal_delivery_attempt_123",
        channelId: REVIEW_CHANNEL_ID,
        startedAt: T0,
      },
    })),
    bindCaseAppealDelivery: vi.fn(),
    failCaseAppealDelivery: vi.fn(),
    markCaseAppealDeliveryMissing: vi.fn(),

    getModerationCaseById: vi.fn(() => state.moderationCase),
    getModerationCaseByNumber: vi.fn(() => state.moderationCase),
    listModerationCases: vi.fn(() => []),
    findUniqueActiveModerationCase: vi.fn(
      (targetUserId: string, actionTypes: readonly string[]) =>
        state.moderationCase?.targetUserId === targetUserId &&
        state.moderationCase.status === "active" &&
        actionTypes.includes(state.moderationCase.actionType)
          ? { status: "found", case: state.moderationCase }
          : { status: "none", case: null },
    ),
    completeExpiredTimeoutCase: vi.fn(),
    finalizeCaseAppealOverturn: vi.fn(),
    reserveModerationCaseAttempt: vi.fn(),
    failModerationCaseAttempt: vi.fn(),
    checkpointTimeoutAppealRemoval: vi.fn(),
    finalizeTimeoutAppealOverturn: vi.fn(),
  };
  return { state, storage };
}

function runtime(guild: Guild, storage: object): GuildRuntime {
  return {
    guildId: GUILD_ID,
    guild,
    storage,
    isCurrent: vi.fn(() => true),
  } as unknown as GuildRuntime;
}

function modalInteraction(
  guild: Guild,
  customId: string,
  userId: string,
  fields: Readonly<Record<string, string>>,
  channelId = REVIEW_CHANNEL_ID,
) {
  const interaction = {
    customId,
    guild,
    guildId: guild.id,
    channelId,
    user: { id: userId },
    client: guild.client,
    fields: {
      getTextInputValue: vi.fn((id: string) => fields[id] ?? ""),
    },
    deferred: false,
    replied: false,
    isModalSubmit: vi.fn(() => true),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
  };
  return interaction;
}

function buttonInteraction(
  harness: ReturnType<typeof guildHarness>,
  customId: string,
  userId = REVIEWER_ID,
) {
  const interaction = {
    customId,
    guild: harness.guild,
    guildId: harness.guild.id,
    channelId: REVIEW_CHANNEL_ID,
    user: { id: userId },
    client: harness.guild.client,
    message: harness.reviewMessage,
    deferred: false,
    replied: false,
    isModalSubmit: vi.fn(() => false),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    showModal: vi.fn(async () => undefined),
  };
  return interaction;
}

function commandInteraction(
  harness: ReturnType<typeof guildHarness>,
  subcommand: "withdraw",
  optionName: "report_number" | "appeal_number",
  value: number,
  userId: string,
) {
  const interaction = {
    guild: harness.guild,
    guildId: harness.guild.id,
    user: { id: userId },
    client: harness.guild.client,
    deferred: false,
    replied: false,
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getInteger: vi.fn((name: string) => (name === optionName ? value : null)),
    },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    showModal: vi.fn(async () => undefined),
  };
  return interaction;
}

function modalCustomId(value: { toJSON(): unknown }): string {
  const customId = (value.toJSON() as { custom_id?: unknown }).custom_id;
  if (typeof customId !== "string") throw new Error("Modal custom ID missing");
  return customId;
}

function rowCustomId(value: { toJSON(): unknown }, index: number): string {
  const components = (
    value.toJSON() as { components?: Array<{ custom_id?: unknown }> }
  ).components;
  const customId = components?.[index]?.custom_id;
  if (typeof customId !== "string") throw new Error("Button custom ID missing");
  return customId;
}

function replyCalls(interaction: {
  editReply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
}): string {
  return JSON.stringify([
    ...interaction.editReply.mock.calls,
    ...interaction.followUp.mock.calls,
    ...interaction.reply.mock.calls,
  ]);
}

describe("Phase 3 report and appeal interactions", () => {
  it("withdraws only the reporter's own pending report with exact CAS", async () => {
    const discord = guildHarness();
    const report = memberReport();
    const withdrawn = memberReport({
      state: "withdrawn",
      withdrawnAt: T1,
      updatedAt: T1,
    });
    const { storage } = storageHarness({ report });
    storage.withdrawMemberReport.mockReturnValue({
      status: "changed",
      report: withdrawn,
    });
    const outsider = commandInteraction(
      discord,
      "withdraw",
      "report_number",
      report.reportNumber,
      TARGET_ID,
    );

    await handleReportCommand(
      outsider as never,
      runtime(discord.guild, storage),
    );

    expect(storage.withdrawMemberReport).not.toHaveBeenCalled();
    expect(replyCalls(outsider)).toContain("not found for your account");

    const owner = commandInteraction(
      discord,
      "withdraw",
      "report_number",
      report.reportNumber,
      REPORTER_ID,
    );
    await handleReportCommand(owner as never, runtime(discord.guild, storage));

    expect(storage.withdrawMemberReport).toHaveBeenCalledWith(report.reportId, {
      reporterId: REPORTER_ID,
      expectedUpdatedAt: T0,
    });
    expect(discord.reviewMessage.edit).toHaveBeenCalledOnce();
    expect(replyCalls(owner)).toContain("withdrawn");
    expect(replyCalls(owner)).not.toContain(report.explanation);
  });

  it("withdraws only the appellant's own pending appeal with exact CAS", async () => {
    const discord = guildHarness();
    const appeal = caseAppeal();
    const withdrawn = caseAppeal({
      state: "withdrawn",
      withdrawnAt: T1,
      updatedAt: T1,
    });
    const { storage } = storageHarness({
      appeal,
      moderationCase: moderationCase(),
    });
    storage.withdrawCaseAppeal.mockReturnValue({
      status: "changed",
      appeal: withdrawn,
    });
    const outsider = commandInteraction(
      discord,
      "withdraw",
      "appeal_number",
      appeal.appealNumber,
      REPORTER_ID,
    );

    await handleAppealCommand(
      outsider as never,
      runtime(discord.guild, storage),
    );

    expect(storage.withdrawCaseAppeal).not.toHaveBeenCalled();
    expect(replyCalls(outsider)).toContain("not found for your account");

    const owner = commandInteraction(
      discord,
      "withdraw",
      "appeal_number",
      appeal.appealNumber,
      TARGET_ID,
    );
    await handleAppealCommand(owner as never, runtime(discord.guild, storage));

    expect(storage.withdrawCaseAppeal).toHaveBeenCalledWith(appeal.appealId, {
      appellantId: TARGET_ID,
      expectedUpdatedAt: T0,
    });
    expect(discord.reviewMessage.edit).toHaveBeenCalledOnce();
    expect(replyCalls(owner)).toContain("withdrawn");
    expect(replyCalls(owner)).not.toContain(appeal.explanation);
    expect(replyCalls(owner)).not.toContain(PRIVATE_CASE_NOTE);
  });

  it("rejects self-targeted report submissions before persistence", async () => {
    const discord = guildHarness();
    const { storage } = storageHarness();
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(createReportSubmitModal("command", REPORTER_ID)),
      REPORTER_ID,
      {
        [REPORT_CATEGORY_FIELD_ID]: "safety",
        [REPORT_EXPLANATION_FIELD_ID]: "This explanation is long enough.",
        [REPORT_EVIDENCE_FIELD_ID]: "",
      },
    );

    await handleReportModal(
      interaction as never,
      runtime(discord.guild, storage),
    );

    expect(storage.reserveMemberReport).not.toHaveBeenCalled();
    expect(replyCalls(interaction)).toContain(
      "Choose another current, non-bot member",
    );
  });

  it("rejects cross-guild report submissions before reading configuration", async () => {
    const discord = guildHarness({ guildId: OTHER_GUILD_ID });
    const { storage } = storageHarness();
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(createReportSubmitModal("command", TARGET_ID)),
      REPORTER_ID,
      {
        [REPORT_CATEGORY_FIELD_ID]: "safety",
        [REPORT_EXPLANATION_FIELD_ID]: "This explanation is long enough.",
        [REPORT_EVIDENCE_FIELD_ID]: "",
      },
    );

    await handleReportModal(
      interaction as never,
      runtime(discord.guild, storage),
    );

    expect(storage.getModerationConfiguration).not.toHaveBeenCalled();
    expect(storage.reserveMemberReport).not.toHaveBeenCalled();
    expect(replyCalls(interaction)).toContain("inside their server");
  });

  it("rejects a report target who is not a current member of the guild", async () => {
    const discord = guildHarness();
    const { storage } = storageHarness();
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(createReportSubmitModal("command", OUTSIDE_MEMBER_ID)),
      REPORTER_ID,
      {
        [REPORT_CATEGORY_FIELD_ID]: "safety",
        [REPORT_EXPLANATION_FIELD_ID]: "This explanation is long enough.",
        [REPORT_EVIDENCE_FIELD_ID]: "",
      },
    );

    await handleReportModal(
      interaction as never,
      runtime(discord.guild, storage),
    );

    expect(storage.reserveMemberReport).not.toHaveBeenCalled();
    expect(replyCalls(interaction)).toContain(
      "Choose another current, non-bot member",
    );
  });

  it("rejects cross-guild evidence links before reservation or evidence fetch", async () => {
    const discord = guildHarness();
    const { storage } = storageHarness();
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(createReportSubmitModal("command", TARGET_ID)),
      REPORTER_ID,
      {
        [REPORT_CATEGORY_FIELD_ID]: "safety",
        [REPORT_EXPLANATION_FIELD_ID]: "This explanation is long enough.",
        [REPORT_EVIDENCE_FIELD_ID]: `https://discord.com/channels/${OTHER_GUILD_ID}/${EVIDENCE_CHANNEL_ID}/${EVIDENCE_MESSAGE_ID}`,
      },
    );

    await handleReportModal(
      interaction as never,
      runtime(discord.guild, storage),
    );

    expect(storage.reserveMemberReport).not.toHaveBeenCalled();
    expect(discord.channelsFetch).not.toHaveBeenCalledWith(
      EVIDENCE_CHANNEL_ID,
      expect.anything(),
    );
    expect(replyCalls(interaction)).toContain("message link from this server");
  });

  it("accepts a verified same-guild evidence link but persists only its identifiers", async () => {
    const discord = guildHarness();
    const { state, storage } = storageHarness();
    const evidenceMessage = {
      id: EVIDENCE_MESSAGE_ID,
      channelId: EVIDENCE_CHANNEL_ID,
      guild: discord.guild,
    } as unknown as Message;
    const evidenceFetch = vi.fn(async () => evidenceMessage);
    const evidenceChannel = {
      id: EVIDENCE_CHANNEL_ID,
      type: ChannelType.GuildText,
      guild: discord.guild,
      messages: { fetch: evidenceFetch },
    } as unknown as TextChannel;
    discord.channelsFetch.mockImplementation(async (id: string) =>
      id === REVIEW_CHANNEL_ID
        ? discord.reviewChannel
        : id === EVIDENCE_CHANNEL_ID
          ? evidenceChannel
          : null,
    );
    const reserved = memberReport({
      evidenceGuildId: GUILD_ID,
      evidenceChannelId: EVIDENCE_CHANNEL_ID,
      evidenceMessageId: EVIDENCE_MESSAGE_ID,
      deliveryState: "reserved",
      reviewChannelId: null,
      reviewMessageId: null,
    });
    const posted = memberReport({
      ...reserved,
      deliveryState: "posted",
      reviewChannelId: REVIEW_CHANNEL_ID,
      reviewMessageId: REVIEW_MESSAGE_ID,
      updatedAt: T1,
    });
    state.report = reserved;
    storage.reserveMemberReport.mockReturnValue({
      status: "created",
      report: reserved,
    });
    storage.claimMemberReportDelivery.mockReturnValue({
      status: "claimed",
      record: reserved,
      claimId: "report_claim_123",
    });
    storage.bindMemberReportDelivery.mockReturnValue({
      status: "changed",
      report: posted,
    });
    const evidenceLink = `https://discord.com/channels/${GUILD_ID}/${EVIDENCE_CHANNEL_ID}/${EVIDENCE_MESSAGE_ID}`;
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(createReportSubmitModal("command", TARGET_ID)),
      REPORTER_ID,
      {
        [REPORT_CATEGORY_FIELD_ID]: "safety",
        [REPORT_EXPLANATION_FIELD_ID]: "This explanation is long enough.",
        [REPORT_EVIDENCE_FIELD_ID]: evidenceLink,
      },
    );

    await handleReportModal(
      interaction as never,
      runtime(discord.guild, storage),
    );

    expect(evidenceFetch).toHaveBeenCalledWith(EVIDENCE_MESSAGE_ID);
    expect(storage.reserveMemberReport).toHaveBeenCalledWith(
      expect.objectContaining({
        evidenceGuildId: GUILD_ID,
        evidenceChannelId: EVIDENCE_CHANNEL_ID,
        evidenceMessageId: EVIDENCE_MESSAGE_ID,
      }),
    );
    expect(
      JSON.stringify(storage.reserveMemberReport.mock.calls),
    ).not.toContain(evidenceLink);
    expect(replyCalls(interaction)).toContain("was submitted");
  });

  it("rejects appeals for cases owned by another member before reservation", async () => {
    const discord = guildHarness();
    const originalCase = moderationCase({ targetUserId: REPORTER_ID });
    const { storage } = storageHarness({ moderationCase: originalCase });
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(
        createAppealSubmitModal("command", originalCase.caseNumber),
      ),
      TARGET_ID,
      {
        [APPEAL_EXPLANATION_FIELD_ID]:
          "This appeal explanation is long enough.",
      },
    );

    await handleAppealModal(
      interaction as never,
      runtime(discord.guild, storage),
    );

    expect(storage.reserveCaseAppeal).not.toHaveBeenCalled();
    expect(replyCalls(interaction)).toContain(
      "not eligible for an appeal by your account",
    );
  });

  it("rejects stale report and appeal controls without a claim mutation", async () => {
    const discord = guildHarness();
    const currentReport = memberReport({ updatedAt: T1 });
    const currentAppeal = caseAppeal({ updatedAt: T1 });
    const originalCase = moderationCase();
    const { storage } = storageHarness({
      report: currentReport,
      appeal: currentAppeal,
      moderationCase: originalCase,
    });
    const reportInteraction = buttonInteraction(
      discord,
      rowCustomId(
        buildReportControlRow(currentReport.reportId, reportVersionToken(T0)),
        0,
      ),
    );
    const appealInteraction = buttonInteraction(
      discord,
      rowCustomId(
        buildAppealControlRow(currentAppeal.appealId, appealVersionToken(T0)),
        0,
      ),
    );

    await handleReportButton(
      reportInteraction as never,
      runtime(discord.guild, storage),
    );
    await handleAppealButton(
      appealInteraction as never,
      runtime(discord.guild, storage),
    );

    expect(storage.claimMemberReport).not.toHaveBeenCalled();
    expect(storage.takeOverMemberReportClaim).not.toHaveBeenCalled();
    expect(storage.claimCaseAppeal).not.toHaveBeenCalled();
    expect(storage.takeOverCaseAppealClaim).not.toHaveBeenCalled();
    expect(replyCalls(reportInteraction)).toContain("control is stale");
    expect(replyCalls(appealInteraction)).toContain("control is stale");
  });

  it("rejects stale decision provenance for both workflows without mutation or notification", async () => {
    const discord = guildHarness();
    const currentReport = memberReport({
      state: "under-review",
      claimedBy: REVIEWER_ID,
      updatedAt: T1,
    });
    const currentAppeal = caseAppeal({
      state: "under-review",
      claimedBy: REVIEWER_ID,
      updatedAt: T1,
    });
    const { storage } = storageHarness({
      report: currentReport,
      appeal: currentAppeal,
      moderationCase: moderationCase(),
    });
    const reportInteraction = modalInteraction(
      discord.guild,
      modalCustomId(
        createReportDecisionModal(
          currentReport.reportId,
          "resolve",
          reportVersionToken(currentReport.updatedAt),
          STALE_REVIEW_MESSAGE_ID,
        ),
      ),
      REVIEWER_ID,
      {
        [REPORT_DECISION_REASON_FIELD_ID]: PRIVATE_DECISION,
        [REPORT_LINKED_CASE_FIELD_ID]: "",
      },
    );
    const appealInteraction = modalInteraction(
      discord.guild,
      modalCustomId(
        createAppealDecisionModal(
          currentAppeal.appealId,
          "uphold",
          appealVersionToken(currentAppeal.updatedAt),
          STALE_REVIEW_MESSAGE_ID,
        ),
      ),
      REVIEWER_ID,
      { [APPEAL_DECISION_REASON_FIELD_ID]: PRIVATE_DECISION },
    );

    await handleReportModal(
      reportInteraction as never,
      runtime(discord.guild, storage),
    );
    await handleAppealModal(
      appealInteraction as never,
      runtime(discord.guild, storage),
    );

    expect(storage.decideMemberReport).not.toHaveBeenCalled();
    expect(storage.decideCaseAppeal).not.toHaveBeenCalled();
    expect(storage.finalizeCaseAppealOverturn).not.toHaveBeenCalled();
    expect(discord.userFetch).not.toHaveBeenCalled();
    expect(replyCalls(reportInteraction)).toContain("decision form is stale");
    expect(replyCalls(appealInteraction)).toContain("decision form is stale");
  });

  it("takes over report and appeal claims only after proving the prior claimant absent", async () => {
    const reportDiscord = guildHarness({ priorStatus: "absent" });
    const claimedReport = memberReport({
      state: "under-review",
      claimedBy: PRIOR_REVIEWER_ID,
    });
    const reportStore = storageHarness({ report: claimedReport });
    reportStore.storage.takeOverMemberReportClaim.mockImplementation(
      (_id, inputValue) => {
        const next = memberReport({
          ...claimedReport,
          claimedBy: REVIEWER_ID,
          updatedAt: T1,
        });
        reportStore.state.report = next;
        return { status: "changed", report: next, inputValue };
      },
    );
    const reportInteraction = buttonInteraction(
      reportDiscord,
      rowCustomId(
        buildReportControlRow(
          claimedReport.reportId,
          reportVersionToken(claimedReport.updatedAt),
        ),
        0,
      ),
    );

    await handleReportButton(
      reportInteraction as never,
      runtime(reportDiscord.guild, reportStore.storage),
    );

    expect(reportStore.storage.takeOverMemberReportClaim).toHaveBeenCalledWith(
      claimedReport.reportId,
      expect.objectContaining({
        reviewerId: REVIEWER_ID,
        previousReviewerId: PRIOR_REVIEWER_ID,
        expectedUpdatedAt: claimedReport.updatedAt,
      }),
    );
    expect(reportStore.storage.claimMemberReport).not.toHaveBeenCalled();

    const appealDiscord = guildHarness({ priorStatus: "absent" });
    const claimedAppeal = caseAppeal({
      state: "under-review",
      claimedBy: PRIOR_REVIEWER_ID,
    });
    const appealStore = storageHarness({
      appeal: claimedAppeal,
      moderationCase: moderationCase(),
    });
    appealStore.storage.takeOverCaseAppealClaim.mockImplementation(
      (_id, inputValue) => {
        const next = caseAppeal({
          ...claimedAppeal,
          claimedBy: REVIEWER_ID,
          updatedAt: T1,
        });
        appealStore.state.appeal = next;
        return { status: "changed", appeal: next, inputValue };
      },
    );
    const appealInteraction = buttonInteraction(
      appealDiscord,
      rowCustomId(
        buildAppealControlRow(
          claimedAppeal.appealId,
          appealVersionToken(claimedAppeal.updatedAt),
        ),
        0,
      ),
    );

    await handleAppealButton(
      appealInteraction as never,
      runtime(appealDiscord.guild, appealStore.storage),
    );

    expect(appealStore.storage.takeOverCaseAppealClaim).toHaveBeenCalledWith(
      claimedAppeal.appealId,
      expect.objectContaining({
        reviewerId: REVIEWER_ID,
        previousReviewerId: PRIOR_REVIEWER_ID,
        expectedUpdatedAt: claimedAppeal.updatedAt,
      }),
    );
    expect(appealStore.storage.claimCaseAppeal).not.toHaveBeenCalled();
  });

  it.each([
    ["authorized", "still assigned to an authorized current reviewer"],
    [
      "unavailable",
      "could not prove whether the current claimant still has access",
    ],
  ] as const)(
    "refuses report and appeal claim takeover when the prior claimant is %s",
    async (priorStatus, expectedMessage) => {
      const reportDiscord = guildHarness({ priorStatus });
      const claimedReport = memberReport({
        state: "under-review",
        claimedBy: PRIOR_REVIEWER_ID,
      });
      const reportStore = storageHarness({ report: claimedReport });
      const reportInteraction = buttonInteraction(
        reportDiscord,
        rowCustomId(
          buildReportControlRow(
            claimedReport.reportId,
            reportVersionToken(claimedReport.updatedAt),
          ),
          0,
        ),
      );
      await handleReportButton(
        reportInteraction as never,
        runtime(reportDiscord.guild, reportStore.storage),
      );

      const appealDiscord = guildHarness({ priorStatus });
      const claimedAppeal = caseAppeal({
        state: "under-review",
        claimedBy: PRIOR_REVIEWER_ID,
      });
      const appealStore = storageHarness({
        appeal: claimedAppeal,
        moderationCase: moderationCase(),
      });
      const appealInteraction = buttonInteraction(
        appealDiscord,
        rowCustomId(
          buildAppealControlRow(
            claimedAppeal.appealId,
            appealVersionToken(claimedAppeal.updatedAt),
          ),
          0,
        ),
      );
      await handleAppealButton(
        appealInteraction as never,
        runtime(appealDiscord.guild, appealStore.storage),
      );

      expect(
        reportStore.storage.takeOverMemberReportClaim,
      ).not.toHaveBeenCalled();
      expect(
        appealStore.storage.takeOverCaseAppealClaim,
      ).not.toHaveBeenCalled();
      expect(replyCalls(reportInteraction)).toContain(expectedMessage);
      expect(replyCalls(appealInteraction)).toContain(expectedMessage);
    },
  );

  it.each([
    ["resolve", "resolved", 2],
    ["dismiss", "dismissed", 3],
  ] as const)(
    "%s saves the exact report CAS and never notifies the target",
    async (decision, state, controlIndex) => {
      const discord = guildHarness();
      const currentReport = memberReport({
        state: "under-review",
        claimedBy: REVIEWER_ID,
      });
      const store = storageHarness({ report: currentReport });
      store.storage.decideMemberReport.mockImplementation((_id, inputValue) => {
        const next = memberReport({
          ...currentReport,
          state,
          decisionBy: REVIEWER_ID,
          decisionReason: PRIVATE_DECISION,
          decidedAt: T1,
          updatedAt: T1,
        });
        store.state.report = next;
        return { status: "changed", report: next, inputValue };
      });
      const openInteraction = buttonInteraction(
        discord,
        rowCustomId(
          buildReportControlRow(
            currentReport.reportId,
            reportVersionToken(currentReport.updatedAt),
          ),
          controlIndex,
        ),
      );
      await handleReportButton(
        openInteraction as never,
        runtime(discord.guild, store.storage),
      );
      expect(openInteraction.showModal).toHaveBeenCalledOnce();
      const decisionInteraction = modalInteraction(
        discord.guild,
        modalCustomId(
          createReportDecisionModal(
            currentReport.reportId,
            decision,
            reportVersionToken(currentReport.updatedAt),
            REVIEW_MESSAGE_ID,
          ),
        ),
        REVIEWER_ID,
        {
          [REPORT_DECISION_REASON_FIELD_ID]: PRIVATE_DECISION,
          [REPORT_LINKED_CASE_FIELD_ID]: "",
        },
      );

      await handleReportModal(
        decisionInteraction as never,
        runtime(discord.guild, store.storage),
      );

      expect(store.storage.decideMemberReport).toHaveBeenCalledWith(
        currentReport.reportId,
        {
          state,
          reviewerId: REVIEWER_ID,
          reason: PRIVATE_DECISION,
          linkedCaseId: null,
          expectedUpdatedAt: currentReport.updatedAt,
        },
      );
      expect(discord.userFetch).not.toHaveBeenCalled();
      expect(discord.dmSend).not.toHaveBeenCalled();
      expect(replyCalls(decisionInteraction)).not.toContain(PRIVATE_DECISION);
      expect(replyCalls(decisionInteraction)).toContain(state);
    },
  );

  it("upholds an appeal with exact CAS and sends only a state notification", async () => {
    const discord = guildHarness();
    const currentAppeal = caseAppeal({
      state: "under-review",
      claimedBy: REVIEWER_ID,
    });
    const currentCase = moderationCase();
    const store = storageHarness({
      appeal: currentAppeal,
      moderationCase: currentCase,
    });
    store.storage.decideCaseAppeal.mockImplementation((_id, inputValue) => {
      const next = caseAppeal({
        ...currentAppeal,
        state: "upheld",
        decisionBy: REVIEWER_ID,
        decisionReason: PRIVATE_DECISION,
        decidedAt: T1,
        updatedAt: T1,
      });
      store.state.appeal = next;
      return { status: "changed", appeal: next, inputValue };
    });
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(
        createAppealDecisionModal(
          currentAppeal.appealId,
          "uphold",
          appealVersionToken(currentAppeal.updatedAt),
          REVIEW_MESSAGE_ID,
        ),
      ),
      REVIEWER_ID,
      { [APPEAL_DECISION_REASON_FIELD_ID]: PRIVATE_DECISION },
    );

    await handleAppealModal(
      interaction as never,
      runtime(discord.guild, store.storage),
    );

    expect(store.storage.decideCaseAppeal).toHaveBeenCalledWith(
      currentAppeal.appealId,
      {
        state: "upheld",
        reviewerId: REVIEWER_ID,
        reason: PRIVATE_DECISION,
        reversalCaseId: null,
        expectedUpdatedAt: currentAppeal.updatedAt,
      },
    );
    expect(discord.dmSend).toHaveBeenCalledOnce();
    const notification = JSON.stringify(discord.dmSend.mock.calls);
    expect(notification).toContain("is now **upheld**");
    expect(notification).toContain('"parse":[]');
    expect(notification).not.toContain(PRIVATE_DECISION);
    expect(notification).not.toContain(PRIVATE_APPEAL);
    expect(notification).not.toContain(PRIVATE_CASE_NOTE);
    expect(replyCalls(interaction)).not.toContain(PRIVATE_DECISION);
  });

  it("atomically overturns a warning with appeal and original-case CAS values", async () => {
    const discord = guildHarness();
    const currentAppeal = caseAppeal({
      state: "under-review",
      claimedBy: REVIEWER_ID,
    });
    const currentCase = moderationCase({ actionType: "warning" });
    const store = storageHarness({
      appeal: currentAppeal,
      moderationCase: currentCase,
    });
    store.storage.finalizeCaseAppealOverturn.mockImplementation(
      (_id, inputValue) => {
        const nextAppeal = caseAppeal({
          ...currentAppeal,
          state: "overturned",
          decisionBy: REVIEWER_ID,
          decisionReason: PRIVATE_DECISION,
          decidedAt: T1,
          updatedAt: T1,
        });
        const nextCase = moderationCase({
          ...currentCase,
          status: "overturned",
          overturnedBy: REVIEWER_ID,
          overturnedAt: T1,
          overturnReason: "Case overturned after authorized appeal review.",
          updatedAt: T1,
        });
        store.state.appeal = nextAppeal;
        store.state.moderationCase = nextCase;
        return {
          status: "changed",
          appeal: nextAppeal,
          originalCase: nextCase,
          reversalCase: null,
          inputValue,
        };
      },
    );
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(
        createAppealDecisionModal(
          currentAppeal.appealId,
          "overturn",
          appealVersionToken(currentAppeal.updatedAt),
          REVIEW_MESSAGE_ID,
        ),
      ),
      REVIEWER_ID,
      { [APPEAL_DECISION_REASON_FIELD_ID]: PRIVATE_DECISION },
    );

    await handleAppealModal(
      interaction as never,
      runtime(discord.guild, store.storage),
    );

    expect(store.storage.finalizeCaseAppealOverturn).toHaveBeenCalledWith(
      currentAppeal.appealId,
      expect.objectContaining({
        reviewerId: REVIEWER_ID,
        decisionReason: PRIVATE_DECISION,
        appealExpectedUpdatedAt: currentAppeal.updatedAt,
        originalExpectedUpdatedAt: currentCase.updatedAt,
      }),
    );
    expect(store.storage.decideCaseAppeal).not.toHaveBeenCalled();
    expect(discord.dmSend).toHaveBeenCalledOnce();
    const notification = JSON.stringify(discord.dmSend.mock.calls);
    expect(notification).toContain("is now **overturned**");
    expect(notification).not.toContain(PRIVATE_DECISION);
    expect(notification).not.toContain(PRIVATE_APPEAL);
    expect(notification).not.toContain(PRIVATE_CASE_NOTE);
  });

  it("records a failed timeout-removal attempt without deciding or notifying", async () => {
    const discord = guildHarness({
      targetTimedOut: true,
      timeoutRejects: true,
    });
    const currentAppeal = caseAppeal({
      state: "under-review",
      claimedBy: REVIEWER_ID,
    });
    const currentCase = moderationCase({
      actionType: "timeout",
      discordActionMetadata: { expiresAt: "2026-08-21T01:00:00.000Z" },
    });
    const attempt = moderationCase({
      caseId: "removal_token_123",
      caseNumber: 43,
      actionType: "timeout-removed",
      source: "appeal-review",
      status: "failed",
      relatedCaseId: currentCase.caseId,
      updatedAt: T1,
    });
    const store = storageHarness({
      appeal: currentAppeal,
      moderationCase: currentCase,
    });
    store.storage.reserveModerationCaseAttempt.mockReturnValue(attempt);
    store.storage.failModerationCaseAttempt.mockReturnValue({
      status: "changed",
      case: attempt,
    });
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(
        createAppealDecisionModal(
          currentAppeal.appealId,
          "overturn",
          appealVersionToken(currentAppeal.updatedAt),
          REVIEW_MESSAGE_ID,
        ),
      ),
      REVIEWER_ID,
      { [APPEAL_DECISION_REASON_FIELD_ID]: PRIVATE_DECISION },
    );

    await handleAppealModal(
      interaction as never,
      runtime(discord.guild, store.storage),
    );

    expect(store.storage.reserveModerationCaseAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUserId: TARGET_ID,
        actorId: REVIEWER_ID,
        actionType: "timeout-removed",
        source: "appeal-review",
        relatedCaseId: currentCase.caseId,
      }),
    );
    expect(discord.targetTimeout).toHaveBeenCalledWith(
      null,
      expect.stringContaining(REVIEWER_ID),
    );
    expect(store.storage.failModerationCaseAttempt).toHaveBeenCalledWith(
      attempt.caseId,
      {
        actorId: REVIEWER_ID,
        failureCode: "discord-timeout-removal-failed",
        expectedUpdatedAt: attempt.updatedAt,
      },
    );
    expect(store.storage.checkpointTimeoutAppealRemoval).not.toHaveBeenCalled();
    expect(store.storage.finalizeTimeoutAppealOverturn).not.toHaveBeenCalled();
    expect(store.storage.decideCaseAppeal).not.toHaveBeenCalled();
    expect(discord.dmSend).not.toHaveBeenCalled();
    expect(replyCalls(interaction)).toContain("appeal was not overturned");
    expect(replyCalls(interaction)).not.toContain(PRIVATE_DECISION);
  });

  it("does not claim a ban reversal or notify while the target remains banned", async () => {
    const discord = guildHarness({ activeBan: true });
    const currentAppeal = caseAppeal({
      state: "under-review",
      claimedBy: REVIEWER_ID,
    });
    const currentCase = moderationCase({
      actionType: "ban",
      status: "completed",
    });
    const store = storageHarness({
      appeal: currentAppeal,
      moderationCase: currentCase,
    });
    const interaction = modalInteraction(
      discord.guild,
      modalCustomId(
        createAppealDecisionModal(
          currentAppeal.appealId,
          "overturn",
          appealVersionToken(currentAppeal.updatedAt),
          REVIEW_MESSAGE_ID,
        ),
      ),
      REVIEWER_ID,
      { [APPEAL_DECISION_REASON_FIELD_ID]: PRIVATE_DECISION },
    );

    await handleAppealModal(
      interaction as never,
      runtime(discord.guild, store.storage),
    );

    expect(discord.banFetch).toHaveBeenCalledWith(TARGET_ID);
    expect(store.storage.finalizeCaseAppealOverturn).not.toHaveBeenCalled();
    expect(store.storage.decideCaseAppeal).not.toHaveBeenCalled();
    expect(discord.dmSend).not.toHaveBeenCalled();
    expect(replyCalls(interaction)).toContain("user is still banned");
    expect(replyCalls(interaction)).not.toContain(PRIVATE_DECISION);
  });
});
