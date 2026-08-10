import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import {
  DISCORD_SNOWFLAKE_PATTERN,
  serializeGuildSettings,
} from "../guild-settings.js";
import type { GuildSettings } from "../types.js";
import {
  convertLegacyMetric,
  convertLegacyV2Settings,
  LEGACY_SILENCE_RECOVERY_METRIC_KEY,
} from "./legacy-v2-converter.js";
import {
  createV4Objects,
  createV4OperationalObjects,
  createV5OperationalObjects,
  createV6OperationalObjects,
  databaseIntegrityCheck,
  detectDatabaseSchema,
  type DatabaseSchemaKind,
  LEGACY_V4_SCHEMA_VERSION,
  recordCurrentSchemaVersion,
  recordV4SchemaVersion,
  recordV5SchemaVersion,
  V2_TABLE_NAMES,
  V4_EXPLICIT_INDEX_NAMES,
  validateV2Schema,
  validateV3Schema,
  validateV4Schema,
  validateV5Schema,
  validateV6Schema,
} from "./schema.js";

export type MigrationFailurePoint =
  | "after-source-read"
  | "after-rename"
  | "after-create"
  | "after-copy"
  | "after-verify"
  | "after-drop"
  | "after-version"
  | "before-commit";

export interface MigrationOptions {
  dbFile: string;
  dryRun?: boolean;
  failurePoint?: MigrationFailurePoint;
  now?: () => string;
  /** Test/diagnostic hook invoked after BEGIN IMMEDIATE and before reads. */
  onLockAcquired?: () => void;
}

export interface MigrationResult {
  status: "migrated" | "dry-run" | "already-current";
  fromSchema:
    "legacy-v2" | "legacy-v3" | "legacy-v4" | "legacy-v5" | "current-v6";
  toSchema: "current-v6";
  guilds: number;
  settingsRequiringReview: number;
  metricsPreserved: number;
  metricsDropped: number;
  warnings: number;
}

export interface DatabaseValidationResult {
  schema: DatabaseSchemaKind;
  schemaVersion: number | null;
  integrity: string;
  foreignKeyViolations: number;
}

interface V3Snapshot {
  guilds: unknown[];
  settings: unknown[];
  metrics: unknown[];
}

interface V4Snapshot {
  configurations: V4TicketConfigurationRow[];
  panels: unknown[];
  tickets: V4TicketRow[];
  events: unknown[];
}

interface V4TicketConfigurationRow {
  guild_id: string;
  enabled: number;
  category_id: string;
  log_channel_id: string;
  support_role_id: string;
  created_at: string;
  updated_at: string;
}

interface V4TicketRow {
  guild_id: string;
  ticket_id: string;
  ticket_number: number;
  opener_id: string;
  channel_id: string | null;
  control_message_id: string | null;
  subject: string;
  description: string;
  state: string;
  claimed_by: string | null;
  claimed_at: string | null;
  closed_by: string | null;
  close_reason: string | null;
  close_log_message_id: string | null;
  close_logged_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  closing_at: string | null;
  closed_at: string | null;
}

interface MigratedDepartment {
  guildId: string;
  departmentId: string;
  subjectFieldId: string;
  detailsFieldId: string;
}

interface LegacyGuildRow {
  guild_id: string;
  enabled: number;
  name: string | null;
  joined_at: string | null;
  left_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LegacySettingsRow {
  guild_id: string;
  settings_version: number;
  settings_json: string;
  updated_at: string;
}

interface LegacyMetricRow {
  guild_id: string;
  metric_key: string;
  metric_value: string;
  updated_at: string;
}

interface PreparedSettingsRow {
  guildId: string;
  settings: GuildSettings;
  json: string;
  updatedAt: string;
}

interface PreparedMetricRow {
  guildId: string;
  key: string;
  value: number;
  updatedAt: string;
}

interface PreparedMigration {
  guilds: LegacyGuildRow[];
  settings: PreparedSettingsRow[];
  metrics: PreparedMetricRow[];
  result: Omit<MigrationResult, "status">;
}

const V2_EXPLICIT_INDEXES = [
  "idx_posts_guild_closed_posted_at",
  "idx_posts_guild_posted_at",
  "idx_answers_guild_question_created",
  "idx_answers_guild_message_id",
  "idx_answers_guild_created_at",
  "idx_guilds_enabled_left_at",
] as const;

class DryRunRollback extends Error {}

export function migrateDatabase(options: MigrationOptions): MigrationResult {
  const db = new Database(options.dbFile, {
    fileMustExist: true,
    timeout: 5_000,
  });
  db.pragma("foreign_keys = ON");

  let dryRunResult: MigrationResult | null = null;
  try {
    const migrate = db.transaction((): MigrationResult => {
      options.onLockAcquired?.();
      assertIntegrity(db);
      const schema = detectDatabaseSchema(db);
      if (schema === "current-v6") {
        const issues = validateV6Schema(db);
        if (issues.length > 0) {
          throw new Error(`Schema v6 validation failed: ${issues.join("; ")}`);
        }
        return {
          status: "already-current",
          fromSchema: "current-v6",
          toSchema: "current-v6",
          guilds: countRows(db, "guilds"),
          settingsRequiringReview: countReviewRequiredSettings(db),
          metricsPreserved: countRows(db, "metrics"),
          metricsDropped: 0,
          warnings: 0,
        };
      }
      if (schema === "legacy-v5") {
        const v5Issues = validateV5Schema(db);
        if (v5Issues.length > 0) {
          throw new Error(
            `Schema v5 validation failed: ${v5Issues.join("; ")}`,
          );
        }
        const now = (options.now ?? utcNow)();
        const result: MigrationResult = {
          status: options.dryRun ? "dry-run" : "migrated",
          fromSchema: "legacy-v5",
          toSchema: "current-v6",
          guilds: countRows(db, "guilds"),
          settingsRequiringReview: countReviewRequiredSettings(db),
          metricsPreserved: countRows(db, "metrics"),
          metricsDropped: 0,
          warnings: 0,
        };
        createV6OperationalObjects(db);
        injectFailure(options, "after-create");
        recordCurrentSchemaVersion(db, now);
        injectFailure(options, "after-version");
        const finalIssues = validateV6Schema(db);
        if (finalIssues.length > 0) {
          throw new Error(
            `Migrated schema validation failed: ${finalIssues.join("; ")}`,
          );
        }
        injectFailure(options, "before-commit");
        if (options.dryRun) {
          dryRunResult = result;
          throw new DryRunRollback("validated dry run");
        }
        return result;
      }
      if (schema === "legacy-v4") {
        const v4Issues = validateV4Schema(db);
        if (v4Issues.length > 0) {
          throw new Error(
            `Schema v4 validation failed: ${v4Issues.join("; ")}`,
          );
        }
        const now = (options.now ?? utcNow)();
        const result: MigrationResult = {
          status: options.dryRun ? "dry-run" : "migrated",
          fromSchema: "legacy-v4",
          toSchema: "current-v6",
          guilds: countRows(db, "guilds"),
          settingsRequiringReview: countReviewRequiredSettings(db),
          metricsPreserved: countRows(db, "metrics"),
          metricsDropped: 0,
          warnings: 0,
        };
        upgradeV4ToV5(db, options, true);
        recordV5SchemaVersion(db, now);
        const v5FinalIssues = validateV5Schema(db);
        if (v5FinalIssues.length > 0) {
          throw new Error(
            `Intermediate schema-v5 validation failed: ${v5FinalIssues.join("; ")}`,
          );
        }
        createV6OperationalObjects(db);
        recordCurrentSchemaVersion(db, now);
        injectFailure(options, "after-version");
        const finalIssues = validateV6Schema(db);
        if (finalIssues.length > 0) {
          throw new Error(
            `Migrated schema validation failed: ${finalIssues.join("; ")}`,
          );
        }
        injectFailure(options, "before-commit");
        if (options.dryRun) {
          dryRunResult = result;
          throw new DryRunRollback("validated dry run");
        }
        return result;
      }
      if (schema === "legacy-v3") {
        const v3Issues = validateV3Schema(db);
        if (v3Issues.length > 0) {
          throw new Error(
            `Schema v3 validation failed: ${v3Issues.join("; ")}`,
          );
        }
        const now = (options.now ?? utcNow)();
        const snapshot = readV3Snapshot(db);
        const result: MigrationResult = {
          status: options.dryRun ? "dry-run" : "migrated",
          fromSchema: "legacy-v3",
          toSchema: "current-v6",
          guilds: snapshot.guilds.length,
          settingsRequiringReview: countReviewRequiredSettings(db),
          metricsPreserved: snapshot.metrics.length,
          metricsDropped: 0,
          warnings: 0,
        };
        injectFailure(options, "after-source-read");
        injectFailure(options, "after-rename");
        createV4OperationalObjects(db);
        injectFailure(options, "after-create");
        injectFailure(options, "after-copy");
        verifyV3Snapshot(db, snapshot);
        injectFailure(options, "after-verify");
        injectFailure(options, "after-drop");
        recordV4SchemaVersion(db, now);
        const v4FinalIssues = validateV4Schema(db);
        if (v4FinalIssues.length > 0) {
          throw new Error(
            `Intermediate schema-v4 validation failed: ${v4FinalIssues.join("; ")}`,
          );
        }
        upgradeV4ToV5(db, options, false);
        recordV5SchemaVersion(db, now);
        const v5FinalIssues = validateV5Schema(db);
        if (v5FinalIssues.length > 0) {
          throw new Error(
            `Intermediate schema-v5 validation failed: ${v5FinalIssues.join("; ")}`,
          );
        }
        createV6OperationalObjects(db);
        recordCurrentSchemaVersion(db, now);
        injectFailure(options, "after-version");
        const finalIssues = validateV6Schema(db);
        if (finalIssues.length > 0) {
          throw new Error(
            `Migrated schema validation failed: ${finalIssues.join("; ")}`,
          );
        }
        injectFailure(options, "before-commit");
        if (options.dryRun) {
          dryRunResult = result;
          throw new DryRunRollback("validated dry run");
        }
        return result;
      }
      if (schema === "legacy-v1") {
        throw new Error(
          "Schema v1 cannot be migrated by v6. Upgrade with the final v4 release to schema v2, stop the bot, create an offline backup, then run the v6 migration.",
        );
      }
      if (schema !== "legacy-v2") {
        throw new Error(
          `Refusing to migrate ${schema}: expected the exact final-v4 schema v2 layout`,
        );
      }

      const v2Issues = validateV2Schema(db);
      if (v2Issues.length > 0) {
        throw new Error(`Schema v2 validation failed: ${v2Issues.join("; ")}`);
      }

      const now = (options.now ?? utcNow)();
      const prepared = prepareMigration(db, now);
      injectFailure(options, "after-source-read");

      for (const index of V2_EXPLICIT_INDEXES) {
        db.exec(`DROP INDEX ${quoteIdentifier(index)}`);
      }
      for (const table of V2_TABLE_NAMES) {
        db.exec(
          `ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(legacyTableName(table))}`,
        );
      }
      injectFailure(options, "after-rename");

      createV4Objects(db);
      injectFailure(options, "after-create");

      copyPreparedRows(db, prepared);
      injectFailure(options, "after-copy");
      verifyPreparedRows(db, prepared);
      injectFailure(options, "after-verify");

      for (const table of [...V2_TABLE_NAMES].reverse()) {
        db.exec(`DROP TABLE ${quoteIdentifier(legacyTableName(table))}`);
      }
      injectFailure(options, "after-drop");

      recordV4SchemaVersion(db, now);
      const v4FinalIssues = validateV4Schema(db);
      if (v4FinalIssues.length > 0) {
        throw new Error(
          `Intermediate schema-v4 validation failed: ${v4FinalIssues.join("; ")}`,
        );
      }

      upgradeV4ToV5(db, options, false);
      // Freeze and validate each intermediate schema marker before adding the
      // next schema's objects.
      recordV5SchemaVersion(db, now);
      const v5FinalIssues = validateV5Schema(db);
      if (v5FinalIssues.length > 0) {
        throw new Error(
          `Intermediate schema-v5 validation failed: ${v5FinalIssues.join("; ")}`,
        );
      }
      createV6OperationalObjects(db);
      // The v6 marker remains the final data write after every intermediate
      // schema has been built and validated.
      recordCurrentSchemaVersion(db, now);
      injectFailure(options, "after-version");

      const finalIssues = validateV6Schema(db);
      if (finalIssues.length > 0) {
        throw new Error(
          `Migrated schema validation failed: ${finalIssues.join("; ")}`,
        );
      }

      const result: MigrationResult = {
        status: options.dryRun ? "dry-run" : "migrated",
        ...prepared.result,
      };
      injectFailure(options, "before-commit");
      if (options.dryRun) {
        dryRunResult = result;
        throw new DryRunRollback("validated dry run");
      }
      return result;
    });

    try {
      return migrate.immediate();
    } catch (error) {
      if (error instanceof DryRunRollback && dryRunResult) {
        return dryRunResult;
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

export function validateDatabaseFile(
  dbFile: string,
  options: { expect: 2 | 3 | 4 | 5 | 6 },
): DatabaseValidationResult {
  const db = new Database(dbFile, {
    readonly: true,
    fileMustExist: true,
  });
  db.pragma("foreign_keys = ON");
  try {
    const integrity = databaseIntegrityCheck(db);
    const schema = detectDatabaseSchema(db);
    const foreignKeyViolations = (db.pragma("foreign_key_check") as unknown[])
      .length;
    const schemaVersion = readSchemaVersion(db, schema);
    const expected = options.expect;
    if (integrity.toLowerCase() !== "ok") {
      throw new Error(`Database integrity check failed: ${integrity}`);
    }
    if (foreignKeyViolations > 0) {
      throw new Error(
        `Database foreign-key check reported ${foreignKeyViolations} violation(s)`,
      );
    }
    if (
      (expected === 2 && schema !== "legacy-v2") ||
      (expected === 3 && schema !== "legacy-v3") ||
      (expected === 4 && schema !== "legacy-v4") ||
      (expected === 5 && schema !== "legacy-v5") ||
      (expected === 6 && schema !== "current-v6")
    ) {
      throw new Error(
        `Database schema is ${schema}; expected exact schema v${expected}`,
      );
    }
    return { schema, schemaVersion, integrity, foreignKeyViolations };
  } finally {
    db.close();
  }
}

function upgradeV4ToV5(
  db: Database.Database,
  options: MigrationOptions,
  injectStages: boolean,
): void {
  const snapshot = readV4Snapshot(db);
  if (injectStages) injectFailure(options, "after-source-read");

  for (const index of V4_EXPLICIT_INDEX_NAMES) {
    if (index !== "idx_guilds_enabled_left_at") {
      db.exec(`DROP INDEX ${quoteIdentifier(index)}`);
    }
  }
  for (const table of [
    "ticket_events",
    "tickets",
    "posted_panels",
    "ticket_configurations",
  ] as const) {
    db.exec(
      `ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(v4LegacyTableName(table))}`,
    );
  }
  if (injectStages) injectFailure(options, "after-rename");

  createV5OperationalObjects(db);
  if (injectStages) injectFailure(options, "after-create");

  const departments = copyV4OperationalRows(db, snapshot);
  if (injectStages) injectFailure(options, "after-copy");
  verifyV4OperationalUpgrade(db, snapshot, departments);
  if (injectStages) injectFailure(options, "after-verify");

  for (const table of [
    "ticket_events",
    "tickets",
    "posted_panels",
    "ticket_configurations",
  ] as const) {
    db.exec(`DROP TABLE ${quoteIdentifier(v4LegacyTableName(table))}`);
  }
  if (injectStages) injectFailure(options, "after-drop");
}

function readV4Snapshot(db: Database.Database): V4Snapshot {
  return {
    configurations: db
      .prepare("SELECT * FROM ticket_configurations ORDER BY guild_id")
      .all() as V4TicketConfigurationRow[],
    panels: db
      .prepare("SELECT * FROM posted_panels ORDER BY guild_id, panel_id")
      .all(),
    tickets: db
      .prepare("SELECT * FROM tickets ORDER BY guild_id, ticket_number")
      .all() as V4TicketRow[],
    events: db
      .prepare(
        "SELECT * FROM ticket_events ORDER BY guild_id, ticket_id, event_number",
      )
      .all(),
  };
}

function copyV4OperationalRows(
  db: Database.Database,
  snapshot: V4Snapshot,
): MigratedDepartment[] {
  db.exec(
    `INSERT INTO posted_panels
     SELECT * FROM ${quoteIdentifier(v4LegacyTableName("posted_panels"))}`,
  );

  const configurationByGuild = new Map(
    snapshot.configurations.map((row) => [row.guild_id, row]),
  );
  const ticketsByGuild = new Map<string, V4TicketRow[]>();
  for (const ticket of snapshot.tickets) {
    const rows = ticketsByGuild.get(ticket.guild_id) ?? [];
    rows.push(ticket);
    ticketsByGuild.set(ticket.guild_id, rows);
  }
  const guildIds = new Set([
    ...configurationByGuild.keys(),
    ...ticketsByGuild.keys(),
  ]);
  const allocatedIds = new Set<string>();
  const departments: MigratedDepartment[] = [];
  const insertDepartment = db.prepare(
    `INSERT INTO ticket_departments (
       guild_id, department_id, slug, display_name, description, emoji,
       category_id, log_channel_id, support_role_id, enabled, sort_order,
       definition_version, bindings_verified_at, created_at, updated_at
     ) VALUES (?, ?, 'general-support', 'General Support', ?, NULL, ?, ?, ?, ?, 0, 1,
       ?, ?, ?)`,
  );
  const insertField = db.prepare(
    `INSERT INTO ticket_department_fields (
       guild_id, department_id, field_id, label, description, placeholder,
       field_type, required, min_length, max_length, sort_order, created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 1, ?, ?, ?, ?)`,
  );

  for (const guildId of [...guildIds].sort()) {
    const configuration = configurationByGuild.get(guildId);
    const guildTickets = ticketsByGuild.get(guildId) ?? [];
    const firstTicket = guildTickets[0];
    const createdAt =
      configuration?.created_at ??
      firstTicket?.created_at ??
      "1970-01-01T00:00:00.000Z";
    const updatedAt =
      configuration?.updated_at ?? firstTicket?.updated_at ?? createdAt;
    const departmentId = allocateOpaqueId(allocatedIds);
    const subjectFieldId = allocateOpaqueId(allocatedIds);
    const detailsFieldId = allocateOpaqueId(allocatedIds);
    insertDepartment.run(
      guildId,
      departmentId,
      "Contact the support team for assistance.",
      configuration?.category_id ?? null,
      configuration?.log_channel_id ?? null,
      configuration?.support_role_id ?? null,
      configuration?.enabled ?? 0,
      configuration?.updated_at ?? null,
      createdAt,
      updatedAt,
    );
    insertField.run(
      guildId,
      departmentId,
      subjectFieldId,
      "Subject",
      "A short summary of what you need",
      "short",
      100,
      0,
      createdAt,
      updatedAt,
    );
    insertField.run(
      guildId,
      departmentId,
      detailsFieldId,
      "Details",
      "Share the context staff need to assist you",
      "paragraph",
      2_000,
      1,
      createdAt,
      updatedAt,
    );
    departments.push({
      guildId,
      departmentId,
      subjectFieldId,
      detailsFieldId,
    });
  }

  const departmentByGuild = new Map(
    departments.map((department) => [department.guildId, department]),
  );
  const insertTicket = db.prepare(
    `INSERT INTO tickets (
       guild_id, ticket_id, ticket_number, department_id, opener_id,
       channel_id, control_message_id, subject, description, state,
       claimed_by, claimed_at, closed_by, close_reason, close_log_message_id,
       close_logged_at, failure_reason, created_at, updated_at, closing_at,
       closed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertResponse = db.prepare(
    `INSERT INTO ticket_form_responses (
       guild_id, ticket_id, response_id, field_id, field_label, field_type,
       response_text, sort_order, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ticket of snapshot.tickets) {
    const department = departmentByGuild.get(ticket.guild_id);
    if (!department) {
      throw new Error(
        `Schema-v4 ticket ${ticket.ticket_id} has no migration department`,
      );
    }
    insertTicket.run(
      ticket.guild_id,
      ticket.ticket_id,
      ticket.ticket_number,
      department.departmentId,
      ticket.opener_id,
      ticket.channel_id,
      ticket.control_message_id,
      ticket.subject,
      ticket.description,
      ticket.state,
      ticket.claimed_by,
      ticket.claimed_at,
      ticket.closed_by,
      ticket.close_reason,
      ticket.close_log_message_id,
      ticket.close_logged_at,
      ticket.failure_reason,
      ticket.created_at,
      ticket.updated_at,
      ticket.closing_at,
      ticket.closed_at,
    );
    insertResponse.run(
      ticket.guild_id,
      ticket.ticket_id,
      allocateOpaqueId(allocatedIds),
      department.subjectFieldId,
      "Subject",
      "short",
      ticket.subject,
      0,
      ticket.created_at,
    );
    insertResponse.run(
      ticket.guild_id,
      ticket.ticket_id,
      allocateOpaqueId(allocatedIds),
      department.detailsFieldId,
      "Details",
      "paragraph",
      ticket.description,
      1,
      ticket.created_at,
    );
  }

  db.exec(
    `INSERT INTO ticket_events
     SELECT * FROM ${quoteIdentifier(v4LegacyTableName("ticket_events"))}`,
  );
  return departments;
}

function verifyV4OperationalUpgrade(
  db: Database.Database,
  snapshot: V4Snapshot,
  departments: MigratedDepartment[],
): void {
  const panels = db
    .prepare("SELECT * FROM posted_panels ORDER BY guild_id, panel_id")
    .all();
  if (!isDeepStrictEqual(panels, snapshot.panels)) {
    throw new Error("Schema-v4 posted panels changed during v5 migration");
  }

  const tickets = db
    .prepare(
      `SELECT guild_id, ticket_id, ticket_number, opener_id, channel_id,
              control_message_id, subject, description, state, claimed_by,
              claimed_at, closed_by, close_reason, close_log_message_id,
              close_logged_at, failure_reason, created_at, updated_at,
              closing_at, closed_at
       FROM tickets ORDER BY guild_id, ticket_number`,
    )
    .all();
  if (!isDeepStrictEqual(tickets, snapshot.tickets)) {
    throw new Error("Schema-v4 tickets changed during v5 migration");
  }

  const events = db
    .prepare(
      "SELECT * FROM ticket_events ORDER BY guild_id, ticket_id, event_number",
    )
    .all();
  if (!isDeepStrictEqual(events, snapshot.events)) {
    throw new Error("Schema-v4 ticket events changed during v5 migration");
  }
  if (countRows(db, "ticket_departments") !== departments.length) {
    throw new Error("Schema-v5 department migration count is inconsistent");
  }
  if (countRows(db, "ticket_department_fields") !== departments.length * 2) {
    throw new Error("Schema-v5 ticket field migration count is inconsistent");
  }
  if (countRows(db, "ticket_form_responses") !== snapshot.tickets.length * 2) {
    throw new Error(
      "Schema-v5 ticket response migration count is inconsistent",
    );
  }

  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new Error("Schema-v5 migrated candidate has foreign-key violations");
  }
}

function prepareMigration(
  db: Database.Database,
  now: string,
): PreparedMigration {
  const guilds = db
    .prepare("SELECT * FROM guilds ORDER BY guild_id")
    .all() as LegacyGuildRow[];
  const settingsRows = db
    .prepare("SELECT * FROM guild_settings ORDER BY guild_id")
    .all() as LegacySettingsRow[];
  const metricRows = db
    .prepare("SELECT * FROM metrics ORDER BY guild_id, metric_key")
    .all() as LegacyMetricRow[];

  assertLegacyGuildRows(guilds);
  assertNoUnresolvedRecoveryMetadata(metricRows);

  const sourceSettings = new Map(
    settingsRows.map((row) => [row.guild_id, row]),
  );
  const settings: PreparedSettingsRow[] = [];
  let settingsRequiringReview = 0;
  let warnings = 0;

  for (const guild of guilds) {
    const source = sourceSettings.get(guild.guild_id);
    let input: unknown = {};
    let sourceEnabled: boolean | null = null;
    if (source?.settings_version === 1) {
      try {
        input = JSON.parse(source.settings_json) as unknown;
        if (
          input &&
          typeof input === "object" &&
          !Array.isArray(input) &&
          typeof (input as { enabled?: unknown }).enabled === "boolean"
        ) {
          sourceEnabled = (input as { enabled: boolean }).enabled;
        }
      } catch {
        input = {};
      }
    }

    const enabledConsistent =
      sourceEnabled !== null && sourceEnabled === Boolean(guild.enabled);
    const converted = convertLegacyV2Settings(enabledConsistent ? input : {}, {
      guildEnabled: Boolean(guild.enabled),
      guildActive: guild.left_at === null,
    });
    if (converted.settings.reviewRequired) {
      settingsRequiringReview += 1;
    }
    warnings += converted.warnings.length;
    guild.enabled = converted.settings.enabled ? 1 : 0;
    settings.push({
      guildId: guild.guild_id,
      settings: converted.settings,
      json: serializeGuildSettings(converted.settings),
      updatedAt: now,
    });
  }

  const preparedMetrics = new Map<string, PreparedMetricRow>();
  let dropped = 0;
  for (const row of metricRows) {
    if (row.metric_key === LEGACY_SILENCE_RECOVERY_METRIC_KEY) {
      dropped += 1;
      continue;
    }
    const converted = convertLegacyMetric(row.metric_key, row.metric_value);
    if (!converted) {
      dropped += 1;
      continue;
    }
    if (!isValidTimestamp(row.updated_at)) {
      dropped += 1;
      continue;
    }
    const mapKey = `${row.guild_id}\u0000${converted.key}`;
    const existing = preparedMetrics.get(mapKey);
    if (!existing) {
      preparedMetrics.set(mapKey, {
        guildId: row.guild_id,
        key: converted.key,
        value: converted.value,
        updatedAt: row.updated_at,
      });
      continue;
    }
    const total = existing.value + converted.value;
    if (!Number.isSafeInteger(total)) {
      throw new Error(
        "Active metric collision exceeds the supported safe-integer range",
      );
    }
    existing.value = total;
    if (Date.parse(row.updated_at) > Date.parse(existing.updatedAt)) {
      existing.updatedAt = row.updated_at;
    }
  }

  return {
    guilds,
    settings,
    metrics: [...preparedMetrics.values()].sort((left, right) =>
      `${left.guildId}\u0000${left.key}`.localeCompare(
        `${right.guildId}\u0000${right.key}`,
      ),
    ),
    result: {
      fromSchema: "legacy-v2",
      toSchema: "current-v6",
      guilds: guilds.length,
      settingsRequiringReview,
      metricsPreserved: preparedMetrics.size,
      metricsDropped: dropped,
      warnings,
    },
  };
}

function copyPreparedRows(
  db: Database.Database,
  prepared: PreparedMigration,
): void {
  const insertGuild = db.prepare(
    `INSERT INTO guilds (
       guild_id, enabled, name, joined_at, left_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const guild of prepared.guilds) {
    insertGuild.run(
      guild.guild_id,
      guild.enabled,
      guild.name,
      guild.joined_at,
      guild.left_at,
      guild.created_at,
      guild.updated_at,
    );
  }

  const insertSettings = db.prepare(
    `INSERT INTO guild_settings (
       guild_id, settings_version, settings_json, updated_at
     ) VALUES (?, 2, ?, ?)`,
  );
  for (const row of prepared.settings) {
    insertSettings.run(row.guildId, row.json, row.updatedAt);
  }

  const insertMetric = db.prepare(
    `INSERT INTO metrics (
       guild_id, metric_key, metric_value, updated_at
     ) VALUES (?, ?, ?, ?)`,
  );
  for (const row of prepared.metrics) {
    insertMetric.run(row.guildId, row.key, row.value, row.updatedAt);
  }
}

function verifyPreparedRows(
  db: Database.Database,
  prepared: PreparedMigration,
): void {
  const guilds = db
    .prepare("SELECT * FROM guilds ORDER BY guild_id")
    .all() as LegacyGuildRow[];
  if (!isDeepStrictEqual(guilds, prepared.guilds)) {
    throw new Error("Migrated guild metadata does not match the prepared copy");
  }

  const settings = db
    .prepare(
      "SELECT guild_id, settings_version, settings_json, updated_at FROM guild_settings ORDER BY guild_id",
    )
    .all() as LegacySettingsRow[];
  const expectedSettings = prepared.settings.map((row) => ({
    guild_id: row.guildId,
    settings_version: 2,
    settings_json: row.json,
    updated_at: row.updatedAt,
  }));
  if (!isDeepStrictEqual(settings, expectedSettings)) {
    throw new Error("Migrated guild settings do not match the prepared copy");
  }

  const metrics = db
    .prepare(
      "SELECT guild_id, metric_key, metric_value, updated_at FROM metrics ORDER BY guild_id, metric_key",
    )
    .all() as Array<{
    guild_id: string;
    metric_key: string;
    metric_value: number;
    updated_at: string;
  }>;
  const expectedMetrics = prepared.metrics.map((row) => ({
    guild_id: row.guildId,
    metric_key: row.key,
    metric_value: row.value,
    updated_at: row.updatedAt,
  }));
  if (!isDeepStrictEqual(metrics, expectedMetrics)) {
    throw new Error("Migrated metrics do not match the prepared copy");
  }

  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new Error("Migrated candidate has foreign-key violations");
  }
}

function readV3Snapshot(db: Database.Database): V3Snapshot {
  return {
    guilds: db.prepare("SELECT * FROM guilds ORDER BY guild_id").all(),
    settings: db
      .prepare("SELECT * FROM guild_settings ORDER BY guild_id")
      .all(),
    metrics: db
      .prepare("SELECT * FROM metrics ORDER BY guild_id, metric_key")
      .all(),
  };
}

function verifyV3Snapshot(db: Database.Database, expected: V3Snapshot): void {
  const actual = readV3Snapshot(db);
  if (!isDeepStrictEqual(actual.guilds, expected.guilds)) {
    throw new Error("Schema v3 guild metadata changed during migration");
  }
  if (!isDeepStrictEqual(actual.settings, expected.settings)) {
    throw new Error("Schema v3 guild settings changed during migration");
  }
  if (!isDeepStrictEqual(actual.metrics, expected.metrics)) {
    throw new Error("Schema v3 metrics changed during migration");
  }
}

function assertLegacyGuildRows(rows: LegacyGuildRow[]): void {
  for (const row of rows) {
    if (!DISCORD_SNOWFLAKE_PATTERN.test(row.guild_id)) {
      throw new Error("Schema v2 contains an invalid guild ID");
    }
    if (row.enabled !== 0 && row.enabled !== 1) {
      throw new Error("Schema v2 contains an invalid enabled value");
    }
    for (const timestamp of [
      row.joined_at,
      row.left_at,
      row.created_at,
      row.updated_at,
    ]) {
      if (timestamp !== null && !isValidTimestamp(timestamp)) {
        throw new Error("Schema v2 contains invalid guild timestamps");
      }
    }
  }
}

function assertNoUnresolvedRecoveryMetadata(rows: LegacyMetricRow[]): void {
  for (const row of rows) {
    if (row.metric_key !== LEGACY_SILENCE_RECOVERY_METRIC_KEY) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metric_value);
    } catch {
      throw new Error(
        "Migration blocked: permission-recovery metadata is malformed. Run the final v4 bot, repair or restore all silence leases, verify the lease list is empty, stop the service, and retry.",
      );
    }
    if (!isValidEmptyRecoveryPayload(parsed)) {
      throw new Error(
        "Migration blocked: unresolved or malformed permission-recovery metadata exists. Run the final v4 bot, restore/cancel every silence lease, verify the lease list is empty, stop the service, and retry.",
      );
    }
  }
}

function isValidEmptyRecoveryPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.version === 1 &&
    Array.isArray(record.leases) &&
    record.leases.length === 0
  );
}

function assertIntegrity(db: Database.Database): void {
  const integrity = databaseIntegrityCheck(db);
  if (integrity.toLowerCase() !== "ok") {
    throw new Error(`Database integrity check failed: ${integrity}`);
  }
}

function injectFailure(
  options: MigrationOptions,
  point: MigrationFailurePoint,
): void {
  if (options.failurePoint === point) {
    throw new Error(`Injected migration failure at ${point}`);
  }
}

function countRows(db: Database.Database, table: string): number {
  return Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)
        .get() as { count: number }
    ).count,
  );
}

function countReviewRequiredSettings(db: Database.Database): number {
  const rows = db
    .prepare("SELECT settings_json FROM guild_settings")
    .all() as Array<{ settings_json: string }>;
  return rows.reduce((count, row) => {
    try {
      const parsed = JSON.parse(row.settings_json) as {
        reviewRequired?: unknown;
      };
      return count + (parsed.reviewRequired === true ? 1 : 0);
    } catch {
      return count;
    }
  }, 0);
}

function readSchemaVersion(
  db: Database.Database,
  schema: DatabaseSchemaKind,
): number | null {
  if (
    schema !== "legacy-v2" &&
    schema !== "legacy-v3" &&
    schema !== "legacy-v4" &&
    schema !== "legacy-v5" &&
    schema !== "current-v6"
  ) {
    return null;
  }
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version === null ? null : Number(row.version);
}

function legacyTableName(table: string): string {
  return `${table}_v2_legacy`;
}

function v4LegacyTableName(table: string): string {
  return `${table}_v4_legacy`;
}

function allocateOpaqueId(allocated: Set<string>): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const value = randomBytes(9).toString("base64url");
    if (!allocated.has(value)) {
      allocated.add(value);
      return value;
    }
  }
  throw new Error("Unable to allocate a unique schema-v5 migration ID");
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function utcNow(): string {
  return new Date().toISOString();
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}
