import type Database from "better-sqlite3";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  ANTI_SPAM_ACTIONS,
  ANTI_SPAM_RULE_TYPES,
  CASE_APPEAL_STATES,
  DELIVERY_STATES,
  MEMBER_REPORT_CATEGORIES,
  MEMBER_REPORT_STATES,
  MODERATION_CASE_ACTION_TYPES,
  MODERATION_CASE_EVENT_TYPES,
  MODERATION_CASE_SOURCES,
  MODERATION_CASE_STATUSES,
  type AntiSpamEnforcement,
  type AntiSpamEvent,
  type AntiSpamExemption,
  type AntiSpamRule,
  type CaseAppeal,
  type CaseAppealEvent,
  type GuildDataExport,
  type MemberReport,
  type MemberReportEvent,
  type ModerationCase,
  type ModerationCaseEvent,
  type ModerationConfiguration,
  type ModerationLogDelivery,
} from "../types.js";
import {
  parseModerationCaseEventRow,
  parseModerationCaseRow,
  parseModerationConfigurationRow,
  parseModerationLogDeliveryRow,
} from "./moderation-case-repository.js";
import { validateModerationCaseMetadata } from "./moderation-case-metadata.js";
import {
  parseCaseAppealEventRow,
  parseCaseAppealRow,
  parseMemberReportEventRow,
  parseMemberReportRow,
} from "./report-appeal-repository.js";
import {
  parseAntiSpamEnforcementRow,
  parseAntiSpamEventRow,
  parseAntiSpamRuleRow,
} from "./anti-spam-repository.js";

export type Phase3GuildData = Pick<
  GuildDataExport,
  | "moderationConfiguration"
  | "moderationCases"
  | "moderationCaseEvents"
  | "moderationLogDeliveries"
  | "memberReports"
  | "memberReportEvents"
  | "caseAppeals"
  | "caseAppealEvents"
  | "antiSpamRules"
  | "antiSpamExemptRoles"
  | "antiSpamExemptChannels"
  | "antiSpamEnforcements"
  | "antiSpamEvents"
>;

export const PHASE3_COLLECTION_LIMITS = Object.freeze({
  moderationCases: 100_000,
  moderationCaseEvents: 10_000_000,
  moderationLogDeliveries: 100_000,
  memberReports: 50_000,
  memberReportEvents: 5_000_000,
  caseAppeals: 50_000,
  caseAppealEvents: 5_000_000,
  antiSpamRules: 3,
  antiSpamExemptRoles: 250,
  antiSpamExemptChannels: 250,
  antiSpamEnforcements: 100_000,
  antiSpamEvents: 100_000,
} as const);

export const PHASE3_GUILD_TABLES = [
  "moderation_configurations",
  "moderation_cases",
  "moderation_case_events",
  "moderation_log_deliveries",
  "member_reports",
  "member_report_events",
  "case_appeals",
  "case_appeal_events",
  "anti_spam_rules",
  "anti_spam_exempt_roles",
  "anti_spam_exempt_channels",
  "anti_spam_enforcements",
  "anti_spam_events",
] as const;

const MAX_EVENTS_PER_PARENT = 100;

export function emptyPhase3GuildData(): Phase3GuildData {
  return {
    moderationConfiguration: null,
    moderationCases: [],
    moderationCaseEvents: [],
    moderationLogDeliveries: [],
    memberReports: [],
    memberReportEvents: [],
    caseAppeals: [],
    caseAppealEvents: [],
    antiSpamRules: [],
    antiSpamExemptRoles: [],
    antiSpamExemptChannels: [],
    antiSpamEnforcements: [],
    antiSpamEvents: [],
  };
}

/** Reads portable Phase 3 state. Live delivery/enforcement leases are excluded. */
export function readPhase3GuildData(
  db: Database.Database,
  guildId: string,
): Phase3GuildData {
  type CollectionKey = Exclude<
    keyof Phase3GuildData,
    "moderationConfiguration"
  >;
  const all = (
    collection: CollectionKey,
    sql: string,
  ): Array<Record<string, unknown>> => {
    const maximum = PHASE3_COLLECTION_LIMITS[collection];
    const rows = db
      .prepare(`${sql} LIMIT ?`)
      .all(guildId, maximum + 1) as Array<Record<string, unknown>>;
    if (rows.length > maximum) {
      throw new RangeError(
        `Guild export ${collection} exceeds the ${maximum}-record safety limit`,
      );
    }
    return rows;
  };
  const configurationRow = db
    .prepare("SELECT * FROM moderation_configurations WHERE guild_id = ?")
    .get(guildId) as Record<string, unknown> | undefined;
  return {
    moderationConfiguration: configurationRow
      ? parseModerationConfigurationRow(configurationRow)
      : null,
    moderationCases: all(
      "moderationCases",
      "SELECT * FROM moderation_cases WHERE guild_id = ? ORDER BY case_number",
    ).map(parseModerationCaseRow),
    moderationCaseEvents: all(
      "moderationCaseEvents",
      `SELECT * FROM moderation_case_events WHERE guild_id = ?
       ORDER BY case_id, event_number, event_id`,
    ).map(parseModerationCaseEventRow),
    moderationLogDeliveries: all(
      "moderationLogDeliveries",
      `SELECT * FROM moderation_log_deliveries WHERE guild_id = ?
       ORDER BY case_id`,
    ).map(parseModerationLogDeliveryRow),
    memberReports: all(
      "memberReports",
      "SELECT * FROM member_reports WHERE guild_id = ? ORDER BY report_number",
    ).map(parseMemberReportRow),
    memberReportEvents: all(
      "memberReportEvents",
      `SELECT * FROM member_report_events WHERE guild_id = ?
       ORDER BY report_id, event_number, event_id`,
    ).map(parseMemberReportEventRow),
    caseAppeals: all(
      "caseAppeals",
      "SELECT * FROM case_appeals WHERE guild_id = ? ORDER BY appeal_number",
    ).map(parseCaseAppealRow),
    caseAppealEvents: all(
      "caseAppealEvents",
      `SELECT * FROM case_appeal_events WHERE guild_id = ?
       ORDER BY appeal_id, event_number, event_id`,
    ).map(parseCaseAppealEventRow),
    antiSpamRules: all(
      "antiSpamRules",
      "SELECT * FROM anti_spam_rules WHERE guild_id = ? ORDER BY rule_type",
    ).map(parseAntiSpamRuleRow),
    antiSpamExemptRoles: all(
      "antiSpamExemptRoles",
      `SELECT guild_id, role_id AS subject_id, created_by, created_at
       FROM anti_spam_exempt_roles WHERE guild_id = ? ORDER BY role_id`,
    ).map(parseExemptionRow),
    antiSpamExemptChannels: all(
      "antiSpamExemptChannels",
      `SELECT guild_id, channel_id AS subject_id, created_by, created_at
       FROM anti_spam_exempt_channels WHERE guild_id = ? ORDER BY channel_id`,
    ).map(parseExemptionRow),
    antiSpamEnforcements: all(
      "antiSpamEnforcements",
      `SELECT * FROM anti_spam_enforcements WHERE guild_id = ?
         AND enforcement_state <> 'reserved'
       ORDER BY created_at, enforcement_id`,
    ).map(parseAntiSpamEnforcementRow),
    antiSpamEvents: all(
      "antiSpamEvents",
      `SELECT * FROM anti_spam_events WHERE guild_id = ?
       ORDER BY event_number, event_id`,
    ).map(parseAntiSpamEventRow),
  };
}

export function parsePhase3GuildData(
  candidate: Record<string, unknown>,
  guildId: string,
): Phase3GuildData {
  const moderationConfiguration = parseConfiguration(
    candidate.moderationConfiguration,
    guildId,
  );
  const moderationCases = parseCases(candidate.moderationCases, guildId);
  const caseIds = new Set(moderationCases.map(({ caseId }) => caseId));
  const casesById = new Map(
    moderationCases.map((moderationCase) => [
      moderationCase.caseId,
      moderationCase,
    ]),
  );
  for (const moderationCase of moderationCases) {
    if (
      moderationCase.relatedCaseId &&
      !caseIds.has(moderationCase.relatedCaseId)
    ) {
      throw new TypeError(
        "Imported moderation case references an unknown related case",
      );
    }
  }
  const moderationCaseEvents = parseParentEvents<ModerationCaseEvent>(
    candidate.moderationCaseEvents,
    PHASE3_COLLECTION_LIMITS.moderationCaseEvents,
    guildId,
    "moderationCaseEvents",
    "caseId",
    caseIds,
    MODERATION_CASE_EVENT_TYPES,
    (
      row,
      parentId,
      eventId,
      eventNumber,
      type,
      actorId,
      details,
      createdAt,
    ) => ({
      guildId,
      caseId: parentId,
      eventId,
      eventNumber,
      type: type as ModerationCaseEvent["type"],
      actorId,
      details,
      createdAt,
    }),
  );
  const moderationLogDeliveries = parseLogDeliveries(
    candidate.moderationLogDeliveries,
    guildId,
    caseIds,
  );
  const memberReports = parseReports(
    candidate.memberReports,
    guildId,
    casesById,
  );
  const reportIds = new Set(memberReports.map(({ reportId }) => reportId));
  const memberReportEvents = parseParentEvents<MemberReportEvent>(
    candidate.memberReportEvents,
    PHASE3_COLLECTION_LIMITS.memberReportEvents,
    guildId,
    "memberReportEvents",
    "reportId",
    reportIds,
    [
      "submission-reserved",
      "submission-posted",
      "submission-failed",
      "claimed",
      "claim-reassigned",
      "claim-released",
      "decision-recorded",
      "withdrawn",
      "rebound",
      "recovery-noted",
    ],
    (
      row,
      parentId,
      eventId,
      eventNumber,
      type,
      actorId,
      details,
      createdAt,
    ) => ({
      guildId,
      reportId: parentId,
      eventId,
      eventNumber,
      type,
      actorId,
      details,
      createdAt,
    }),
  );
  const caseAppeals = parseAppeals(candidate.caseAppeals, guildId, casesById);
  const appealIds = new Set(caseAppeals.map(({ appealId }) => appealId));
  const caseAppealEvents = parseParentEvents<CaseAppealEvent>(
    candidate.caseAppealEvents,
    PHASE3_COLLECTION_LIMITS.caseAppealEvents,
    guildId,
    "caseAppealEvents",
    "appealId",
    appealIds,
    [
      "submission-reserved",
      "submission-posted",
      "submission-failed",
      "claimed",
      "claim-reassigned",
      "claim-released",
      "decision-recorded",
      "withdrawn",
      "rebound",
      "recovery-noted",
    ],
    (
      row,
      parentId,
      eventId,
      eventNumber,
      type,
      actorId,
      details,
      createdAt,
    ) => ({
      guildId,
      appealId: parentId,
      eventId,
      eventNumber,
      type,
      actorId,
      details,
      createdAt,
    }),
  );
  const antiSpamRules = parseRules(candidate.antiSpamRules, guildId);
  const ruleTypes = new Set(antiSpamRules.map(({ ruleType }) => ruleType));
  const antiSpamExemptRoles = parseExemptions(
    candidate.antiSpamExemptRoles,
    PHASE3_COLLECTION_LIMITS.antiSpamExemptRoles,
    guildId,
    "antiSpamExemptRoles",
    true,
  );
  const antiSpamExemptChannels = parseExemptions(
    candidate.antiSpamExemptChannels,
    PHASE3_COLLECTION_LIMITS.antiSpamExemptChannels,
    guildId,
    "antiSpamExemptChannels",
    false,
  );
  const antiSpamEnforcements = parseEnforcements(
    candidate.antiSpamEnforcements,
    guildId,
    ruleTypes,
    caseIds,
  );
  const antiSpamEvents = parseAntiSpamEvents(
    candidate.antiSpamEvents,
    guildId,
    caseIds,
  );
  return {
    moderationConfiguration,
    moderationCases,
    moderationCaseEvents,
    moderationLogDeliveries,
    memberReports,
    memberReportEvents,
    caseAppeals,
    caseAppealEvents,
    antiSpamRules,
    antiSpamExemptRoles,
    antiSpamExemptChannels,
    antiSpamEnforcements,
    antiSpamEvents,
  };
}

/** Inserts parsed Phase 3 history while making every external binding dormant. */
export function insertPhase3GuildData(
  db: Database.Database,
  guildId: string,
  imported: Phase3GuildData,
): void {
  insertConfiguration(db, guildId, imported.moderationConfiguration);
  insertCases(db, guildId, imported.moderationCases);
  insertCaseEvents(db, guildId, imported.moderationCaseEvents);
  insertLogDeliveries(db, guildId, imported.moderationLogDeliveries);
  insertReports(db, guildId, imported.memberReports);
  insertReportEvents(db, guildId, imported.memberReportEvents);
  insertAppeals(db, guildId, imported.caseAppeals);
  insertAppealEvents(db, guildId, imported.caseAppealEvents);
  insertRules(db, guildId, imported.antiSpamRules);
  insertExemptions(db, guildId, imported.antiSpamExemptRoles, true);
  insertExemptions(db, guildId, imported.antiSpamExemptChannels, false);
  insertEnforcements(db, guildId, imported.antiSpamEnforcements);
  insertAntiSpamEvents(db, guildId, imported.antiSpamEvents);
  deactivatePhase3Bindings(db, guildId);
}

export function deactivatePhase3Bindings(
  db: Database.Database,
  guildId: string,
): void {
  db.prepare(
    `UPDATE moderation_configurations SET cases_enabled = 0,
       moderation_log_verified_at = NULL, reports_enabled = 0,
       report_bindings_verified_at = NULL, appeals_enabled = 0,
       appeal_bindings_verified_at = NULL, anti_spam_enabled = 0
     WHERE guild_id = ?`,
  ).run(guildId);
  db.prepare("UPDATE anti_spam_rules SET enabled = 0 WHERE guild_id = ?").run(
    guildId,
  );
  for (const table of [
    "moderation_log_deliveries",
    "member_reports",
    "case_appeals",
  ] as const) {
    db.prepare(
      `UPDATE ${table} SET delivery_claim_id = NULL,
         delivery_claim_expires_at = NULL WHERE guild_id = ?`,
    ).run(guildId);
  }
}

function parseConfiguration(
  value: unknown,
  guildId: string,
): ModerationConfiguration | null {
  if (value === null) return null;
  const row = record(value, "moderationConfiguration");
  tenant(row, guildId, "moderation configuration");
  const configuration: ModerationConfiguration = {
    guildId,
    casesEnabled: boolean(row.casesEnabled, "casesEnabled"),
    moderationLogChannelId: nullableSnowflake(
      row.moderationLogChannelId,
      "moderation log channel ID",
    ),
    moderationLogVerifiedAt: nullableTimestamp(row.moderationLogVerifiedAt),
    reportsEnabled: boolean(row.reportsEnabled, "reportsEnabled"),
    reportReviewChannelId: nullableSnowflake(
      row.reportReviewChannelId,
      "report review channel ID",
    ),
    reportReviewerRoleId: nullableSnowflake(
      row.reportReviewerRoleId,
      "report reviewer role ID",
    ),
    reportBindingsVerifiedAt: nullableTimestamp(row.reportBindingsVerifiedAt),
    appealsEnabled: boolean(row.appealsEnabled, "appealsEnabled"),
    appealReviewChannelId: nullableSnowflake(
      row.appealReviewChannelId,
      "appeal review channel ID",
    ),
    appealReviewerRoleId: nullableSnowflake(
      row.appealReviewerRoleId,
      "appeal reviewer role ID",
    ),
    appealBindingsVerifiedAt: nullableTimestamp(row.appealBindingsVerifiedAt),
    antiSpamEnabled: boolean(row.antiSpamEnabled, "antiSpamEnabled"),
    reportCooldownLimit: integer(
      row.reportCooldownLimit,
      1,
      10,
      "report cooldown limit",
    ),
    reportCooldownWindowSeconds: integer(
      row.reportCooldownWindowSeconds,
      60,
      86_400,
      "report cooldown window",
    ),
    createdBy: snowflake(row.createdBy, "configuration creator ID"),
    updatedBy: snowflake(row.updatedBy, "configuration updater ID"),
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  };
  if (
    configuration.moderationLogVerifiedAt &&
    !configuration.moderationLogChannelId
  )
    throw new TypeError("Imported verified moderation log has no channel");
  if (
    configuration.reportReviewerRoleId === guildId ||
    configuration.appealReviewerRoleId === guildId
  )
    throw new TypeError("Imported reviewer role cannot be @everyone");
  if (
    configuration.reportsEnabled &&
    (!configuration.reportReviewChannelId ||
      !configuration.reportReviewerRoleId ||
      !configuration.reportBindingsVerifiedAt)
  )
    throw new TypeError("Imported enabled reports require verified bindings");
  if (
    configuration.appealsEnabled &&
    (!configuration.appealReviewChannelId ||
      !configuration.appealReviewerRoleId ||
      !configuration.appealBindingsVerifiedAt)
  )
    throw new TypeError("Imported enabled appeals require verified bindings");
  return configuration;
}

function parseCases(value: unknown, guildId: string): ModerationCase[] {
  const rows = array(
    value,
    PHASE3_COLLECTION_LIMITS.moderationCases,
    "moderationCases",
  );
  const ids = new Set<string>();
  const numbers = new Set<number>();
  return rows.map((value): ModerationCase => {
    const row = record(value, "moderation case");
    tenant(row, guildId, "moderation case");
    const caseId = opaque(row.caseId, "case ID");
    const caseNumber = integer(row.caseNumber, 1, 2_147_483_647, "case number");
    unique(ids, caseId, "case ID");
    unique(numbers, caseNumber, "case number");
    const status = enumValue(
      row.status,
      MODERATION_CASE_STATUSES,
      "case status",
    );
    const actionType = enumValue(
      row.actionType,
      MODERATION_CASE_ACTION_TYPES,
      "case action type",
    );
    const source = enumValue(
      row.source,
      MODERATION_CASE_SOURCES,
      "case source",
    );
    const moderationCase: ModerationCase = {
      guildId,
      caseId,
      caseNumber,
      targetUserId: snowflake(row.targetUserId, "case target ID"),
      actorId: snowflake(row.actorId, "case actor ID"),
      actionType,
      source,
      publicReason: text(row.publicReason, 1, 500, "case public reason"),
      privateNote: nullableText(row.privateNote, 1, 1_000, "case private note"),
      discordActionMetadata: validateModerationCaseMetadata(
        json(row.discordActionMetadata, 8_000, "case Discord metadata"),
        source,
        actionType,
      ),
      status,
      relatedCaseId: nullableOpaque(row.relatedCaseId, "related case ID"),
      voidedBy: nullableSnowflake(row.voidedBy, "void actor ID"),
      voidedAt: nullableTimestamp(row.voidedAt),
      voidReason: nullableText(row.voidReason, 1, 1_000, "void reason"),
      overturnedBy: nullableSnowflake(row.overturnedBy, "overturn actor ID"),
      overturnedAt: nullableTimestamp(row.overturnedAt),
      overturnReason: nullableText(
        row.overturnReason,
        1,
        1_000,
        "overturn reason",
      ),
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
    };
    if (moderationCase.relatedCaseId === caseId)
      throw new TypeError("Imported case cannot relate to itself");
    const hasVoid = Boolean(
      moderationCase.voidedBy &&
      moderationCase.voidedAt &&
      moderationCase.voidReason,
    );
    const hasOverturn = Boolean(
      moderationCase.overturnedBy &&
      moderationCase.overturnedAt &&
      moderationCase.overturnReason,
    );
    if (
      (status === "voided") !== hasVoid ||
      (status === "overturned") !== hasOverturn
    )
      throw new TypeError(
        "Imported case terminal metadata does not match its status",
      );
    return moderationCase;
  });
}

function parseLogDeliveries(
  value: unknown,
  guildId: string,
  caseIds: Set<string>,
): ModerationLogDelivery[] {
  const rows = array(
    value,
    PHASE3_COLLECTION_LIMITS.moderationLogDeliveries,
    "moderationLogDeliveries",
  );
  const parents = new Set<string>();
  return rows.map((value): ModerationLogDelivery => {
    const row = record(value, "moderation log delivery");
    tenant(row, guildId, "moderation log delivery");
    const caseId = opaque(row.caseId, "log case ID");
    reference(caseIds, caseId, "moderation log case");
    unique(parents, caseId, "moderation log case");
    const state = enumValue(
      row.state,
      ["pending", "delivered", "failed", "missing"] as const,
      "log delivery state",
    );
    const channelId = nullableSnowflake(row.channelId, "log channel ID");
    const messageId = nullableSnowflake(row.messageId, "log message ID");
    const deliveredAt = nullableTimestamp(row.deliveredAt);
    if (
      (state === "delivered" && !messageId) ||
      (["pending", "failed"].includes(state) && Boolean(messageId)) ||
      Boolean(messageId) !== Boolean(deliveredAt) ||
      (messageId && !channelId)
    )
      throw new TypeError("Imported moderation log checkpoint is inconsistent");
    return {
      guildId,
      caseId,
      state,
      channelId,
      messageId,
      attemptCount: integer(row.attemptCount, 0, 1_000, "log attempt count"),
      lastFailureCode: nullableText(
        row.lastFailureCode,
        1,
        100,
        "log failure code",
      ),
      deliveredAt,
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
    };
  });
}

function parseReports(
  value: unknown,
  guildId: string,
  casesById: Map<string, ModerationCase>,
): MemberReport[] {
  const rows = array(
    value,
    PHASE3_COLLECTION_LIMITS.memberReports,
    "memberReports",
  );
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const messages = new Set<string>();
  return rows.map((value): MemberReport => {
    const row = record(value, "member report");
    tenant(row, guildId, "member report");
    const reportId = opaque(row.reportId, "report ID");
    const reportNumber = integer(
      row.reportNumber,
      1,
      2_147_483_647,
      "report number",
    );
    unique(ids, reportId, "report ID");
    unique(numbers, reportNumber, "report number");
    const reporterId = snowflake(row.reporterId, "reporter ID");
    const targetUserId = snowflake(row.targetUserId, "report target ID");
    if (reporterId === targetUserId)
      throw new TypeError("Imported report is a self-report");
    const evidenceGuildId = nullableSnowflake(
      row.evidenceGuildId,
      "evidence guild ID",
    );
    const evidenceChannelId = nullableSnowflake(
      row.evidenceChannelId,
      "evidence channel ID",
    );
    const evidenceMessageId = nullableSnowflake(
      row.evidenceMessageId,
      "evidence message ID",
    );
    if (evidenceGuildId && evidenceGuildId !== guildId)
      throw new TypeError("Imported report evidence belongs to another guild");
    if (
      new Set([
        Boolean(evidenceGuildId),
        Boolean(evidenceChannelId),
        Boolean(evidenceMessageId),
      ]).size !== 1
    )
      throw new TypeError(
        "Imported report evidence IDs must be supplied together",
      );
    const state = enumValue(row.state, MEMBER_REPORT_STATES, "report state");
    const deliveryState = enumValue(
      row.deliveryState,
      DELIVERY_STATES,
      "report delivery state",
    );
    const reviewChannelId = nullableSnowflake(
      row.reviewChannelId,
      "report review channel ID",
    );
    const reviewMessageId = nullableSnowflake(
      row.reviewMessageId,
      "report review message ID",
    );
    if (
      Boolean(reviewChannelId) !== Boolean(reviewMessageId) ||
      ["posted", "missing"].includes(deliveryState) !== Boolean(reviewMessageId)
    )
      throw new TypeError(
        "Imported report delivery checkpoint is inconsistent",
      );
    if (reviewMessageId)
      unique(
        messages,
        `${reviewChannelId}\u0000${reviewMessageId}`,
        "report review message",
      );
    const claimedBy = nullableSnowflake(row.claimedBy, "report claimant ID");
    const claimedAt = nullableTimestamp(row.claimedAt);
    const decisionBy = nullableSnowflake(
      row.decisionBy,
      "report decision actor ID",
    );
    const decisionReason = nullableText(
      row.decisionReason,
      1,
      1_000,
      "report decision reason",
    );
    const decidedAt = nullableTimestamp(row.decidedAt);
    const linkedCaseId = nullableOpaque(
      row.linkedCaseId,
      "report linked case ID",
    );
    const linkedCase = linkedCaseId ? casesById.get(linkedCaseId) : null;
    if (linkedCaseId && !linkedCase)
      throw new TypeError("Imported report references an unknown linked case");
    if (
      linkedCase &&
      (state !== "resolved" ||
        linkedCase.targetUserId !== targetUserId ||
        !["active", "completed"].includes(linkedCase.status) ||
        ![
          "warning",
          "timeout",
          "kick",
          "ban",
          "automod-warning",
          "automod-timeout",
        ].includes(linkedCase.actionType) ||
        Date.parse(linkedCase.createdAt) < Date.parse(timestamp(row.createdAt)))
    ) {
      throw new TypeError(
        "Imported report linked case does not match its resolved target",
      );
    }
    const withdrawnAt = nullableTimestamp(row.withdrawnAt);
    if (
      Boolean(claimedBy) !== Boolean(claimedAt) ||
      (state === "under-review" && !claimedBy)
    )
      throw new TypeError("Imported report claim metadata is inconsistent");
    if (
      ["resolved", "dismissed"].includes(state) !==
      Boolean(decisionBy && decisionReason && decidedAt)
    )
      throw new TypeError("Imported report decision metadata is inconsistent");
    if ((state === "withdrawn") !== Boolean(withdrawnAt))
      throw new TypeError(
        "Imported report withdrawal metadata is inconsistent",
      );
    return {
      guildId,
      reportId,
      reportNumber,
      reporterId,
      targetUserId,
      category: enumValue(
        row.category,
        MEMBER_REPORT_CATEGORIES,
        "report category",
      ),
      explanation: text(row.explanation, 10, 2_000, "report explanation"),
      evidenceGuildId,
      evidenceChannelId,
      evidenceMessageId,
      state,
      deliveryState,
      reviewChannelId,
      reviewMessageId,
      claimedBy,
      claimedAt,
      decisionBy,
      decisionReason,
      decidedAt,
      linkedCaseId,
      withdrawnAt,
      failureCode: nullableText(row.failureCode, 1, 100, "report failure code"),
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
    };
  });
}

function parseAppeals(
  value: unknown,
  guildId: string,
  casesById: Map<string, ModerationCase>,
): CaseAppeal[] {
  const rows = array(
    value,
    PHASE3_COLLECTION_LIMITS.caseAppeals,
    "caseAppeals",
  );
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const cases = new Set<string>();
  const messages = new Set<string>();
  return rows.map((value): CaseAppeal => {
    const row = record(value, "case appeal");
    tenant(row, guildId, "case appeal");
    const appealId = opaque(row.appealId, "appeal ID");
    const appealNumber = integer(
      row.appealNumber,
      1,
      2_147_483_647,
      "appeal number",
    );
    const caseId = opaque(row.caseId, "appealed case ID");
    unique(ids, appealId, "appeal ID");
    unique(numbers, appealNumber, "appeal number");
    unique(cases, caseId, "appealed case");
    const originalCase = casesById.get(caseId);
    if (!originalCase)
      throw new TypeError("Imported appeal references an unknown case");
    const appellantId = snowflake(row.appellantId, "appellant ID");
    if (
      originalCase.targetUserId !== appellantId ||
      !["warning", "timeout", "kick", "ban"].includes(originalCase.actionType)
    ) {
      throw new TypeError(
        "Imported appeal does not belong to an eligible case target",
      );
    }
    const state = enumValue(row.state, CASE_APPEAL_STATES, "appeal state");
    const deliveryState = enumValue(
      row.deliveryState,
      DELIVERY_STATES,
      "appeal delivery state",
    );
    const reviewChannelId = nullableSnowflake(
      row.reviewChannelId,
      "appeal review channel ID",
    );
    const reviewMessageId = nullableSnowflake(
      row.reviewMessageId,
      "appeal review message ID",
    );
    if (
      Boolean(reviewChannelId) !== Boolean(reviewMessageId) ||
      ["posted", "missing"].includes(deliveryState) !== Boolean(reviewMessageId)
    )
      throw new TypeError(
        "Imported appeal delivery checkpoint is inconsistent",
      );
    if (reviewMessageId)
      unique(
        messages,
        `${reviewChannelId}\u0000${reviewMessageId}`,
        "appeal review message",
      );
    const claimedBy = nullableSnowflake(row.claimedBy, "appeal claimant ID");
    const claimedAt = nullableTimestamp(row.claimedAt);
    const decisionBy = nullableSnowflake(
      row.decisionBy,
      "appeal decision actor ID",
    );
    const decisionReason = nullableText(
      row.decisionReason,
      1,
      1_000,
      "appeal decision reason",
    );
    const decidedAt = nullableTimestamp(row.decidedAt);
    const reversalCaseId = nullableOpaque(
      row.reversalCaseId,
      "appeal reversal case ID",
    );
    const reversalCase = reversalCaseId ? casesById.get(reversalCaseId) : null;
    if (reversalCaseId && !reversalCase)
      throw new TypeError(
        "Imported appeal references an unknown reversal case",
      );
    const withdrawnAt = nullableTimestamp(row.withdrawnAt);
    if (
      Boolean(claimedBy) !== Boolean(claimedAt) ||
      (state === "under-review" && !claimedBy)
    )
      throw new TypeError("Imported appeal claim metadata is inconsistent");
    if (
      ["upheld", "overturned"].includes(state) !==
      Boolean(decisionBy && decisionReason && decidedAt)
    )
      throw new TypeError("Imported appeal decision metadata is inconsistent");
    if ((state === "withdrawn") !== Boolean(withdrawnAt))
      throw new TypeError(
        "Imported appeal withdrawal metadata is inconsistent",
      );
    if (state !== "overturned" && reversalCaseId) {
      throw new TypeError(
        "Only an overturned appeal may reference a reversal case",
      );
    }
    if (state === "overturned") {
      if (originalCase.status !== "overturned") {
        throw new TypeError(
          "Imported overturned appeal has a non-overturned original case",
        );
      }
      const expectedReversalAction =
        originalCase.actionType === "timeout"
          ? "timeout-removed"
          : originalCase.actionType === "ban"
            ? "unban"
            : null;
      if (
        (expectedReversalAction === null && reversalCaseId !== null) ||
        (expectedReversalAction !== null &&
          (!reversalCase ||
            reversalCase.actionType !== expectedReversalAction ||
            reversalCase.status !== "completed" ||
            reversalCase.targetUserId !== originalCase.targetUserId ||
            reversalCase.relatedCaseId !== originalCase.caseId ||
            originalCase.relatedCaseId !== reversalCase.caseId))
      ) {
        throw new TypeError(
          "Imported appeal reversal case is not the exact completed inverse action",
        );
      }
    }
    return {
      guildId,
      appealId,
      appealNumber,
      caseId,
      appellantId,
      explanation: text(row.explanation, 10, 2_000, "appeal explanation"),
      state,
      deliveryState,
      reviewChannelId,
      reviewMessageId,
      claimedBy,
      claimedAt,
      decisionBy,
      decisionReason,
      decidedAt,
      reversalCaseId,
      withdrawnAt,
      failureCode: nullableText(row.failureCode, 1, 100, "appeal failure code"),
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
    };
  });
}

function parseRules(value: unknown, guildId: string): AntiSpamRule[] {
  const rows = array(
    value,
    PHASE3_COLLECTION_LIMITS.antiSpamRules,
    "antiSpamRules",
  );
  const types = new Set<string>();
  return rows.map((value): AntiSpamRule => {
    const row = record(value, "anti-spam rule");
    tenant(row, guildId, "anti-spam rule");
    const ruleType = enumValue(
      row.ruleType,
      ANTI_SPAM_RULE_TYPES,
      "anti-spam rule type",
    );
    unique(types, ruleType, "anti-spam rule type");
    const action = enumValue(row.action, ANTI_SPAM_ACTIONS, "anti-spam action");
    const windowSeconds = nullableInteger(
      row.windowSeconds,
      1,
      300,
      "anti-spam window",
    );
    const timeoutSeconds = nullableInteger(
      row.timeoutSeconds,
      60,
      2_419_200,
      "anti-spam timeout",
    );
    if ((ruleType === "mention") !== (windowSeconds === null))
      throw new TypeError("Imported mention rule window is inconsistent");
    if ((action === "delete-and-timeout") !== (timeoutSeconds !== null))
      throw new TypeError("Imported timeout rule duration is inconsistent");
    return {
      guildId,
      ruleType,
      enabled: boolean(row.enabled, "anti-spam enabled"),
      threshold: integer(row.threshold, 2, 100, "anti-spam threshold"),
      windowSeconds,
      action,
      timeoutSeconds,
      cooldownSeconds: integer(
        row.cooldownSeconds,
        1,
        86_400,
        "anti-spam cooldown",
      ),
      createdBy: snowflake(row.createdBy, "anti-spam creator ID"),
      updatedBy: snowflake(row.updatedBy, "anti-spam updater ID"),
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
    };
  });
}

function parseExemptions(
  value: unknown,
  maximum: number,
  guildId: string,
  label: string,
  role: boolean,
): AntiSpamExemption[] {
  const rows = array(value, maximum, label);
  const subjects = new Set<string>();
  return rows.map((value): AntiSpamExemption => {
    const row = record(value, label);
    tenant(row, guildId, label);
    const subjectId = snowflake(row.subjectId, `${label} subject ID`);
    if (role && subjectId === guildId)
      throw new TypeError("Imported @everyone anti-spam exemption is invalid");
    unique(subjects, subjectId, `${label} subject`);
    return {
      guildId,
      subjectId,
      createdBy: snowflake(row.createdBy, `${label} creator ID`),
      createdAt: timestamp(row.createdAt),
    };
  });
}

function parseEnforcements(
  value: unknown,
  guildId: string,
  ruleTypes: Set<string>,
  caseIds: Set<string>,
): AntiSpamEnforcement[] {
  const rows = array(
    value,
    PHASE3_COLLECTION_LIMITS.antiSpamEnforcements,
    "antiSpamEnforcements",
  );
  const ids = new Set<string>();
  const deliveries = new Set<string>();
  return rows.map((value): AntiSpamEnforcement => {
    const row = record(value, "anti-spam enforcement");
    tenant(row, guildId, "anti-spam enforcement");
    const enforcementId = opaque(row.enforcementId, "enforcement ID");
    const ruleType = enumValue(
      row.ruleType,
      ANTI_SPAM_RULE_TYPES,
      "enforcement rule type",
    );
    reference(ruleTypes, ruleType, "enforcement rule");
    const messageId = snowflake(row.messageId, "enforcement message ID");
    const memberId = snowflake(row.memberId, "enforcement member ID");
    unique(ids, enforcementId, "enforcement ID");
    unique(
      deliveries,
      `${ruleType}\u0000${messageId}\u0000${memberId}`,
      "enforcement delivery",
    );
    const state = enumValue(
      row.state,
      ["deleted", "warned", "timed-out", "failed", "skipped"] as const,
      "enforcement state",
    );
    const caseId = nullableOpaque(row.caseId, "enforcement case ID");
    if (caseId) reference(caseIds, caseId, "enforcement case");
    if (["warned", "timed-out"].includes(state) && !caseId)
      throw new TypeError("Imported punitive enforcement has no case");
    return {
      guildId,
      enforcementId,
      ruleType,
      messageId,
      memberId,
      channelId: snowflake(row.channelId, "enforcement channel ID"),
      observedCount: integer(
        row.observedCount,
        1,
        1_000,
        "enforcement observed count",
      ),
      state,
      reservationId: null,
      caseId,
      failureCode: nullableText(
        row.failureCode,
        1,
        100,
        "enforcement failure code",
      ),
      reservationExpiresAt: null,
      completedAt: timestamp(row.completedAt),
      createdAt: timestamp(row.createdAt),
      updatedAt: timestamp(row.updatedAt),
    };
  });
}

function parseAntiSpamEvents(
  value: unknown,
  guildId: string,
  caseIds: Set<string>,
): AntiSpamEvent[] {
  const rows = array(
    value,
    PHASE3_COLLECTION_LIMITS.antiSpamEvents,
    "antiSpamEvents",
  );
  const ids = new Set<string>();
  const numbers = new Set<number>();
  return rows.map((value): AntiSpamEvent => {
    const row = record(value, "anti-spam event");
    tenant(row, guildId, "anti-spam event");
    const eventId = opaque(row.eventId, "anti-spam event ID");
    const eventNumber = integer(
      row.eventNumber,
      1,
      2_147_483_647,
      "anti-spam event number",
    );
    unique(ids, eventId, "anti-spam event ID");
    unique(numbers, eventNumber, "anti-spam event number");
    const caseId = nullableOpaque(row.caseId, "anti-spam event case ID");
    if (caseId) reference(caseIds, caseId, "anti-spam event case");
    return {
      guildId,
      eventId,
      eventNumber,
      ruleType: enumValue(
        row.ruleType,
        ANTI_SPAM_RULE_TYPES,
        "anti-spam event rule type",
      ),
      messageId: snowflake(row.messageId, "anti-spam event message ID"),
      memberId: snowflake(row.memberId, "anti-spam event member ID"),
      channelId: snowflake(row.channelId, "anti-spam event channel ID"),
      observedCount: integer(
        row.observedCount,
        1,
        1_000,
        "anti-spam event observed count",
      ),
      outcome: enumValue(
        row.outcome,
        ["deleted", "warned", "timed-out", "failed", "skipped"] as const,
        "anti-spam event outcome",
      ),
      caseId,
      failureCode: nullableText(
        row.failureCode,
        1,
        100,
        "anti-spam event failure code",
      ),
      createdAt: timestamp(row.createdAt),
    };
  });
}

function parseParentEvents<T>(
  value: unknown,
  maximum: number,
  guildId: string,
  label: string,
  parentKey: string,
  parentIds: Set<string>,
  types: readonly string[],
  build: (
    row: Record<string, unknown>,
    parentId: string,
    eventId: string,
    eventNumber: number,
    type: string,
    actorId: string | null,
    details: unknown,
    createdAt: string,
  ) => T,
): T[] {
  const rows = array(value, maximum, label);
  const ids = new Set<string>();
  const numbers = new Set<string>();
  const counts = new Map<string, number>();
  return rows.map((value) => {
    const row = record(value, label);
    tenant(row, guildId, label);
    const parentId = opaque(row[parentKey], `${label} parent ID`);
    reference(parentIds, parentId, `${label} parent`);
    const count = (counts.get(parentId) ?? 0) + 1;
    if (count > MAX_EVENTS_PER_PARENT)
      throw new RangeError(
        `Imported ${label} exceeds ${MAX_EVENTS_PER_PARENT} events for one parent`,
      );
    counts.set(parentId, count);
    const eventId = opaque(row.eventId, `${label} event ID`);
    const eventNumber = integer(
      row.eventNumber,
      1,
      2_147_483_647,
      `${label} event number`,
    );
    unique(ids, `${parentId}\u0000${eventId}`, `${label} event ID`);
    unique(numbers, `${parentId}\u0000${eventNumber}`, `${label} event number`);
    return build(
      row,
      parentId,
      eventId,
      eventNumber,
      enumValue(row.type, types, `${label} event type`),
      nullableSnowflake(row.actorId, `${label} actor ID`),
      json(row.details, 4_000, `${label} details`),
      timestamp(row.createdAt),
    );
  });
}

function insertConfiguration(
  db: Database.Database,
  guildId: string,
  value: ModerationConfiguration | null,
): void {
  if (!value) return;
  db.prepare(
    `INSERT INTO moderation_configurations (
       guild_id, cases_enabled, moderation_log_channel_id,
       moderation_log_verified_at, reports_enabled, report_review_channel_id,
       report_reviewer_role_id, report_bindings_verified_at, appeals_enabled,
       appeal_review_channel_id, appeal_reviewer_role_id,
       appeal_bindings_verified_at, anti_spam_enabled, report_cooldown_limit,
       report_cooldown_window_seconds, created_by, updated_by, created_at,
       updated_at
     ) VALUES (?, 0, ?, NULL, 0, ?, ?, NULL, 0, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?)`,
  ).run(
    guildId,
    value.moderationLogChannelId,
    value.reportReviewChannelId,
    value.reportReviewerRoleId,
    value.appealReviewChannelId,
    value.appealReviewerRoleId,
    value.reportCooldownLimit,
    value.reportCooldownWindowSeconds,
    value.createdBy,
    value.updatedBy,
    value.createdAt,
    value.updatedAt,
  );
}

function insertCases(
  db: Database.Database,
  guildId: string,
  rows: readonly ModerationCase[],
): void {
  const insert = db.prepare(
    `INSERT INTO moderation_cases (
       guild_id, case_id, case_number, target_user_id, actor_id, action_type,
       source, public_reason, private_note, discord_action_metadata_json,
       status, related_case_id, voided_by, voided_at, void_reason,
       overturned_by, overturned_at, overturn_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      guildId,
      row.caseId,
      row.caseNumber,
      row.targetUserId,
      row.actorId,
      row.actionType,
      row.source,
      row.publicReason,
      row.privateNote,
      serialize(row.discordActionMetadata, 8_000, "case metadata"),
      row.status,
      row.voidedBy,
      row.voidedAt,
      row.voidReason,
      row.overturnedBy,
      row.overturnedAt,
      row.overturnReason,
      row.createdAt,
      row.updatedAt,
    );
  }
  const updateRelation = db.prepare(
    "UPDATE moderation_cases SET related_case_id = ? WHERE guild_id = ? AND case_id = ?",
  );
  for (const row of rows)
    if (row.relatedCaseId)
      updateRelation.run(row.relatedCaseId, guildId, row.caseId);
}

function insertCaseEvents(
  db: Database.Database,
  guildId: string,
  rows: readonly ModerationCaseEvent[],
): void {
  const insert = db.prepare(
    `INSERT INTO moderation_case_events (
       guild_id, case_id, event_id, event_number, event_type, actor_id,
       details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.caseId,
      row.eventId,
      row.eventNumber,
      row.type,
      row.actorId,
      serialize(row.details, 4_000, "case event details"),
      row.createdAt,
    );
}

function insertLogDeliveries(
  db: Database.Database,
  guildId: string,
  rows: readonly ModerationLogDelivery[],
): void {
  const insert = db.prepare(
    `INSERT INTO moderation_log_deliveries (
       guild_id, case_id, delivery_state, channel_id, message_id,
       attempt_count, last_failure_code, delivery_claim_id,
       delivery_claim_expires_at, delivered_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.caseId,
      row.state,
      row.channelId,
      row.messageId,
      row.attemptCount,
      row.lastFailureCode,
      row.deliveredAt,
      row.createdAt,
      row.updatedAt,
    );
}

function insertReports(
  db: Database.Database,
  guildId: string,
  rows: readonly MemberReport[],
): void {
  const insert = db.prepare(
    `INSERT INTO member_reports (
       guild_id, report_id, report_number, reporter_id, target_user_id,
       category, explanation, evidence_guild_id, evidence_channel_id,
       evidence_message_id, state, delivery_state, review_channel_id,
       review_message_id, claimed_by, claimed_at, decision_by,
       decision_reason, decided_at, linked_case_id, withdrawn_at, failure_code,
       delivery_claim_id, delivery_claim_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.reportId,
      row.reportNumber,
      row.reporterId,
      row.targetUserId,
      row.category,
      row.explanation,
      row.evidenceGuildId,
      row.evidenceChannelId,
      row.evidenceMessageId,
      row.state,
      row.deliveryState,
      row.reviewChannelId,
      row.reviewMessageId,
      row.claimedBy,
      row.claimedAt,
      row.decisionBy,
      row.decisionReason,
      row.decidedAt,
      row.linkedCaseId,
      row.withdrawnAt,
      row.failureCode,
      row.createdAt,
      row.updatedAt,
    );
}

function insertReportEvents(
  db: Database.Database,
  guildId: string,
  rows: readonly MemberReportEvent[],
): void {
  const insert = db.prepare(
    `INSERT INTO member_report_events (
       guild_id, report_id, event_id, event_number, event_type, actor_id,
       details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.reportId,
      row.eventId,
      row.eventNumber,
      row.type,
      row.actorId,
      serialize(row.details, 4_000, "report event details"),
      row.createdAt,
    );
}

function insertAppeals(
  db: Database.Database,
  guildId: string,
  rows: readonly CaseAppeal[],
): void {
  const insert = db.prepare(
    `INSERT INTO case_appeals (
       guild_id, appeal_id, appeal_number, case_id, appellant_id, explanation,
       state, delivery_state, review_channel_id, review_message_id, claimed_by,
       claimed_at, decision_by, decision_reason, decided_at, reversal_case_id,
       withdrawn_at, failure_code, delivery_claim_id,
       delivery_claim_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.appealId,
      row.appealNumber,
      row.caseId,
      row.appellantId,
      row.explanation,
      row.state,
      row.deliveryState,
      row.reviewChannelId,
      row.reviewMessageId,
      row.claimedBy,
      row.claimedAt,
      row.decisionBy,
      row.decisionReason,
      row.decidedAt,
      row.reversalCaseId,
      row.withdrawnAt,
      row.failureCode,
      row.createdAt,
      row.updatedAt,
    );
}

function insertAppealEvents(
  db: Database.Database,
  guildId: string,
  rows: readonly CaseAppealEvent[],
): void {
  const insert = db.prepare(
    `INSERT INTO case_appeal_events (
       guild_id, appeal_id, event_id, event_number, event_type, actor_id,
       details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.appealId,
      row.eventId,
      row.eventNumber,
      row.type,
      row.actorId,
      serialize(row.details, 4_000, "appeal event details"),
      row.createdAt,
    );
}

function insertRules(
  db: Database.Database,
  guildId: string,
  rows: readonly AntiSpamRule[],
): void {
  const insert = db.prepare(
    `INSERT INTO anti_spam_rules (
       guild_id, rule_type, enabled, threshold, window_seconds, action,
       timeout_seconds, cooldown_seconds, created_by, updated_by, created_at,
       updated_at
     ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.ruleType,
      row.threshold,
      row.windowSeconds,
      row.action,
      row.timeoutSeconds,
      row.cooldownSeconds,
      row.createdBy,
      row.updatedBy,
      row.createdAt,
      row.updatedAt,
    );
}

function insertExemptions(
  db: Database.Database,
  guildId: string,
  rows: readonly AntiSpamExemption[],
  role: boolean,
): void {
  const table = role ? "anti_spam_exempt_roles" : "anti_spam_exempt_channels";
  const column = role ? "role_id" : "channel_id";
  const insert = db.prepare(
    `INSERT INTO ${table} (guild_id, ${column}, created_by, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(guildId, row.subjectId, row.createdBy, row.createdAt);
}

function insertEnforcements(
  db: Database.Database,
  guildId: string,
  rows: readonly AntiSpamEnforcement[],
): void {
  const insert = db.prepare(
    `INSERT INTO anti_spam_enforcements (
       guild_id, enforcement_id, rule_type, message_id, member_id, channel_id,
       observed_count, enforcement_state, reservation_id, case_id,
       failure_code, reservation_expires_at, completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.enforcementId,
      row.ruleType,
      row.messageId,
      row.memberId,
      row.channelId,
      row.observedCount,
      row.state,
      row.caseId,
      row.failureCode,
      row.completedAt,
      row.createdAt,
      row.updatedAt,
    );
}

function insertAntiSpamEvents(
  db: Database.Database,
  guildId: string,
  rows: readonly AntiSpamEvent[],
): void {
  const insert = db.prepare(
    `INSERT INTO anti_spam_events (
       guild_id, event_id, event_number, rule_type, message_id, member_id,
       channel_id, observed_count, outcome, case_id, failure_code, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(
      guildId,
      row.eventId,
      row.eventNumber,
      row.ruleType,
      row.messageId,
      row.memberId,
      row.channelId,
      row.observedCount,
      row.outcome,
      row.caseId,
      row.failureCode,
      row.createdAt,
    );
}

function parseExemptionRow(row: Record<string, unknown>): AntiSpamExemption {
  return {
    guildId: String(row.guild_id),
    subjectId: String(row.subject_id),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Guild import ${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value))
    throw new TypeError(`Guild import ${label} must be an array`);
  if (value.length > maximum)
    throw new RangeError(`Guild import ${label} exceeds ${maximum} records`);
  return value;
}
function tenant(
  row: Record<string, unknown>,
  guildId: string,
  label: string,
): void {
  if (row.guildId !== guildId)
    throw new TypeError(`Imported ${label} belongs to another guild`);
}
function snowflake(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new TypeError(`${label} must be a Discord snowflake`);
  return assertDiscordSnowflake(value, label);
}
function nullableSnowflake(value: unknown, label: string): string | null {
  return value === null ? null : snowflake(value, label);
}
function opaque(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,24}$/.test(value))
    throw new TypeError(`${label} must be an opaque ID`);
  return value;
}
function nullableOpaque(value: unknown, label: string): string | null {
  return value === null ? null : opaque(value, label);
}
function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  return Number(value);
}
function nullableInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number | null {
  return value === null ? null : integer(value, minimum, maximum, label);
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${label} must be boolean`);
  return value;
}
function text(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  )
    throw new RangeError(
      `${label} must contain ${minimum}-${maximum} safe characters`,
    );
  return normalized;
}
function nullableText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string | null {
  return value === null ? null : text(value, minimum, maximum, label);
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new TypeError("Imported timestamp must be an ISO timestamp");
  return new Date(Date.parse(value)).toISOString();
}
function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}
function enumValue<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  if (!(choices as readonly unknown[]).includes(value))
    throw new TypeError(`Unsupported ${label}`);
  return value as T;
}
function unique<T>(seen: Set<T>, value: T, label: string): void {
  if (seen.has(value))
    throw new TypeError(`Guild import contains duplicate ${label}`);
  seen.add(value);
}
function reference<T>(known: Set<T>, value: T, label: string): void {
  if (!known.has(value)) throw new TypeError(`Imported ${label} is unknown`);
}
function serialize(value: unknown, maximum: number, label: string): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`Imported ${label} must be JSON-safe`);
  }
  if (
    !encoded ||
    encoded.length < 2 ||
    Buffer.byteLength(encoded, "utf8") > maximum
  )
    throw new RangeError(`Imported ${label} exceeds ${maximum} bytes`);
  return encoded;
}
function json(value: unknown, maximum: number, label: string): unknown {
  return JSON.parse(serialize(value, maximum, label)) as unknown;
}
