import type { DatabaseConnection } from "./database.js";
import { assertDiscordSnowflake } from "../guild-settings.js";
import {
  APPLICATION_EVENT_TYPES,
  APPLICATION_STATES,
  DELIVERY_STATES,
  FORM_FIELD_TYPES,
  GUILD_CAPABILITIES,
  SUGGESTION_EVENT_TYPES,
  SUGGESTION_STATES,
  type ApplicationEvent,
  type ApplicationForm,
  type ApplicationFormField,
  type ApplicationRecord,
  type ApplicationResponse,
  type DelegatedCapabilityGrant,
  type GuildDataExport,
  type GuildCapability,
  type PanelPreset,
  type PostedPanel,
  type SuggestionConfiguration,
  type SuggestionEvent,
  type SuggestionRecord,
  type SuggestionVote,
  type TicketDepartment,
  type TicketDepartmentField,
  type TicketConfiguration,
  type TicketEvent,
  type TicketFormResponse,
  type TicketRecord,
} from "../types.js";
import { normalizeUnicodeEmoji } from "../unicode-emoji.js";

export type Phase2OperationalData = Pick<
  GuildDataExport,
  | "delegatedCapabilityGrants"
  | "ticketDepartments"
  | "ticketDepartmentFields"
  | "postedPanels"
  | "tickets"
  | "ticketFormResponses"
  | "ticketEvents"
  | "suggestionConfiguration"
  | "suggestions"
  | "suggestionVotes"
  | "suggestionEvents"
  | "applicationForms"
  | "applicationFormFields"
  | "applications"
  | "applicationResponses"
  | "applicationEvents"
>;

export const PHASE2_COLLECTION_LIMITS = Object.freeze({
  delegatedCapabilityGrants: 1_000,
  ticketDepartments: 10,
  ticketDepartmentFields: 50,
  postedPanels: 5_000,
  tickets: 10_000,
  ticketFormResponses: 50_000,
  ticketEvents: 100_000,
  suggestions: 10_000,
  suggestionVotes: 250_000,
  suggestionEvents: 100_000,
  applicationForms: 25,
  applicationFormFields: 125,
  applications: 10_000,
  applicationResponses: 50_000,
  applicationEvents: 100_000,
} as const);

const MAX_AUDIT_EVENTS_PER_PARENT = 100;

export const PHASE2_GUILD_TABLES = [
  "delegated_capability_grants",
  "ticket_departments",
  "ticket_department_fields",
  "posted_panels",
  "tickets",
  "ticket_form_responses",
  "ticket_events",
  "suggestion_configurations",
  "suggestions",
  "suggestion_votes",
  "suggestion_events",
  "application_forms",
  "application_form_fields",
  "applications",
  "application_responses",
  "application_events",
] as const;

/** Leaves preserved or inserted workflow rows dormant after every import. */
export function deactivatePhase2OperationalBindings(
  db: DatabaseConnection,
  guildId: string,
): void {
  db.prepare(
    "UPDATE delegated_capability_grants SET active = 0 WHERE guild_id = ?",
  ).run(guildId);
  db.prepare(
    `UPDATE ticket_departments
     SET enabled = 0, bindings_verified_at = NULL
     WHERE guild_id = ?`,
  ).run(guildId);
  db.prepare(
    `UPDATE suggestion_configurations
     SET enabled = 0, bindings_verified_at = NULL
     WHERE guild_id = ?`,
  ).run(guildId);
  db.prepare(
    `UPDATE application_forms
     SET enabled = 0, bindings_verified_at = NULL
     WHERE guild_id = ?`,
  ).run(guildId);
}

export function emptyPhase2OperationalData(): Phase2OperationalData {
  return {
    delegatedCapabilityGrants: [],
    ticketDepartments: [],
    ticketDepartmentFields: [],
    postedPanels: [],
    tickets: [],
    ticketFormResponses: [],
    ticketEvents: [],
    suggestionConfiguration: null,
    suggestions: [],
    suggestionVotes: [],
    suggestionEvents: [],
    applicationForms: [],
    applicationFormFields: [],
    applications: [],
    applicationResponses: [],
    applicationEvents: [],
  };
}

export function upgradeLegacyV3OperationalData(input: {
  ticketConfiguration: TicketConfiguration | null;
  postedPanels: PostedPanel[];
  tickets: Array<Omit<TicketRecord, "departmentId">>;
  ticketEvents: TicketEvent[];
  fallbackTimestamp: string;
}): Phase2OperationalData {
  const empty = emptyPhase2OperationalData();
  if (!input.ticketConfiguration && input.tickets.length === 0) {
    return { ...empty, postedPanels: input.postedPanels };
  }
  const configuration = input.ticketConfiguration;
  const firstTicket = input.tickets[0];
  const createdAt =
    configuration?.createdAt ??
    firstTicket?.createdAt ??
    input.fallbackTimestamp;
  const updatedAt =
    configuration?.updatedAt ??
    firstTicket?.updatedAt ??
    input.fallbackTimestamp;
  const departmentId = "general_support";
  const subjectFieldId = "subject_default";
  const detailsFieldId = "details_default";
  const department: TicketDepartment = {
    guildId:
      configuration?.guildId ??
      firstTicket?.guildId ??
      input.postedPanels[0]?.guildId ??
      "",
    departmentId,
    slug: "general-support",
    displayName: "General Support",
    description: "Contact the support team for assistance.",
    emoji: null,
    categoryId: configuration?.categoryId ?? null,
    logChannelId: configuration?.logChannelId ?? null,
    supportRoleId: configuration?.supportRoleId ?? null,
    enabled: configuration?.enabled ?? false,
    sortOrder: 0,
    definitionVersion: 1,
    bindingsVerifiedAt: null,
    createdAt,
    updatedAt,
  };
  const fields: TicketDepartmentField[] = [
    {
      guildId: department.guildId,
      departmentId,
      fieldId: subjectFieldId,
      label: "Subject",
      description: null,
      placeholder: "A short summary of what you need",
      fieldType: "short",
      required: true,
      minLength: 1,
      maxLength: 100,
      sortOrder: 0,
      createdAt,
      updatedAt,
    },
    {
      guildId: department.guildId,
      departmentId,
      fieldId: detailsFieldId,
      label: "Details",
      description: null,
      placeholder: "Share the context staff need to assist you",
      fieldType: "paragraph",
      required: true,
      minLength: 1,
      maxLength: 2_000,
      sortOrder: 1,
      createdAt,
      updatedAt,
    },
  ];
  const tickets: TicketRecord[] = input.tickets.map((ticket) => ({
    ...ticket,
    departmentId,
  }));
  const responses: TicketFormResponse[] = tickets.flatMap((ticket) => [
    {
      guildId: ticket.guildId,
      ticketId: ticket.ticketId,
      responseId: "subject_answer",
      fieldId: subjectFieldId,
      fieldLabel: "Subject",
      fieldType: "short",
      responseText: ticket.subject,
      sortOrder: 0,
      createdAt: ticket.createdAt,
    },
    {
      guildId: ticket.guildId,
      ticketId: ticket.ticketId,
      responseId: "details_answer",
      fieldId: detailsFieldId,
      fieldLabel: "Details",
      fieldType: "paragraph",
      responseText: ticket.description,
      sortOrder: 1,
      createdAt: ticket.createdAt,
    },
  ]);
  return {
    ...empty,
    ticketDepartments: [department],
    ticketDepartmentFields: fields,
    postedPanels: input.postedPanels,
    tickets,
    ticketFormResponses: responses,
    ticketEvents: input.ticketEvents,
  };
}

export function readPhase2OperationalData(
  db: DatabaseConnection,
  guildId: string,
): Phase2OperationalData {
  const all = <T>(sql: string): T[] => db.prepare(sql).all(guildId) as T[];
  const get = <T>(sql: string): T | undefined =>
    db.prepare(sql).get(guildId) as T | undefined;

  const grants = all<Record<string, unknown>>(
    `SELECT * FROM delegated_capability_grants
     WHERE guild_id = ? ORDER BY principal_type, principal_id, capability`,
  ).map(mapCapabilityGrant);
  const departments = all<Record<string, unknown>>(
    `SELECT * FROM ticket_departments
     WHERE guild_id = ? ORDER BY sort_order, department_id`,
  ).map(mapTicketDepartment);
  const departmentFields = all<Record<string, unknown>>(
    `SELECT * FROM ticket_department_fields
     WHERE guild_id = ? ORDER BY department_id, sort_order, field_id`,
  ).map(mapTicketDepartmentField);
  const panels = all<Record<string, unknown>>(
    `SELECT * FROM posted_panels
     WHERE guild_id = ? ORDER BY preset, channel_id, panel_id`,
  ).map(mapPostedPanel);
  const tickets = all<Record<string, unknown>>(
    `SELECT * FROM tickets
     WHERE guild_id = ? ORDER BY ticket_number`,
  ).map(mapTicket);
  const ticketResponses = all<Record<string, unknown>>(
    `SELECT * FROM ticket_form_responses
     WHERE guild_id = ? ORDER BY ticket_id, sort_order, response_id`,
  ).map(mapTicketResponse);
  const ticketEvents = all<Record<string, unknown>>(
    `SELECT * FROM ticket_events
     WHERE guild_id = ? ORDER BY ticket_id, event_number, event_id`,
  ).map(mapTicketEvent);
  const suggestionConfigurationRow = get<Record<string, unknown>>(
    "SELECT * FROM suggestion_configurations WHERE guild_id = ?",
  );
  const suggestions = all<Record<string, unknown>>(
    `SELECT * FROM suggestions
     WHERE guild_id = ? ORDER BY suggestion_number`,
  ).map(mapSuggestion);
  const suggestionVotes = all<Record<string, unknown>>(
    `SELECT * FROM suggestion_votes
     WHERE guild_id = ? ORDER BY suggestion_id, voter_id`,
  ).map(mapSuggestionVote);
  const suggestionEvents = all<Record<string, unknown>>(
    `SELECT * FROM suggestion_events
     WHERE guild_id = ? ORDER BY suggestion_id, event_number, event_id`,
  ).map(mapSuggestionEvent);
  const applicationForms = all<Record<string, unknown>>(
    `SELECT * FROM application_forms
     WHERE guild_id = ? ORDER BY sort_order, form_id`,
  ).map(mapApplicationForm);
  const applicationFormFields = all<Record<string, unknown>>(
    `SELECT * FROM application_form_fields
     WHERE guild_id = ? ORDER BY form_id, sort_order, field_id`,
  ).map(mapApplicationFormField);
  const applications = all<Record<string, unknown>>(
    `SELECT * FROM applications
     WHERE guild_id = ? ORDER BY application_number`,
  ).map(mapApplication);
  const applicationResponses = all<Record<string, unknown>>(
    `SELECT * FROM application_responses
     WHERE guild_id = ? ORDER BY application_id, sort_order, response_id`,
  ).map(mapApplicationResponse);
  const applicationEvents = all<Record<string, unknown>>(
    `SELECT * FROM application_events
     WHERE guild_id = ? ORDER BY application_id, event_number, event_id`,
  ).map(mapApplicationEvent);

  return {
    delegatedCapabilityGrants: grants,
    ticketDepartments: departments,
    ticketDepartmentFields: departmentFields,
    postedPanels: panels,
    tickets,
    ticketFormResponses: ticketResponses,
    ticketEvents,
    suggestionConfiguration: suggestionConfigurationRow
      ? mapSuggestionConfiguration(suggestionConfigurationRow)
      : null,
    suggestions,
    suggestionVotes,
    suggestionEvents,
    applicationForms,
    applicationFormFields,
    applications,
    applicationResponses,
    applicationEvents,
  };
}

export function parsePhase2OperationalData(
  candidate: Record<string, unknown>,
  guildId: string,
  allowedPanelPresets: readonly PanelPreset[] = PHASE2_PANEL_PRESETS,
  allowedCapabilities: readonly GuildCapability[] = GUILD_CAPABILITIES,
): Phase2OperationalData {
  const delegatedCapabilityGrants = parseCapabilityGrants(
    candidate.delegatedCapabilityGrants,
    guildId,
    allowedCapabilities,
  );
  const ticketDepartments = parseTicketDepartments(
    candidate.ticketDepartments,
    guildId,
  );
  const ticketDepartmentFields = parseTicketDepartmentFields(
    candidate.ticketDepartmentFields,
    guildId,
    ticketDepartments,
  );
  const postedPanels = parsePostedPanels(
    candidate.postedPanels,
    guildId,
    allowedPanelPresets,
  );
  const tickets = parseTickets(candidate.tickets, guildId, ticketDepartments);
  const ticketFormResponses = parseTicketResponses(
    candidate.ticketFormResponses,
    guildId,
    tickets,
  );
  const ticketEvents = parseTicketEvents(
    candidate.ticketEvents,
    guildId,
    tickets,
  );
  const suggestionConfiguration = parseSuggestionConfiguration(
    candidate.suggestionConfiguration,
    guildId,
  );
  const suggestions = parseSuggestions(candidate.suggestions, guildId);
  const suggestionVotes = parseSuggestionVotes(
    candidate.suggestionVotes,
    guildId,
    suggestions,
  );
  const suggestionEvents = parseSuggestionEvents(
    candidate.suggestionEvents,
    guildId,
    suggestions,
  );
  const applicationForms = parseApplicationForms(
    candidate.applicationForms,
    guildId,
  );
  const applicationFormFields = parseApplicationFormFields(
    candidate.applicationFormFields,
    guildId,
    applicationForms,
  );
  validateEnabledApplicationForms(applicationForms, applicationFormFields);
  const applications = parseApplications(
    candidate.applications,
    guildId,
    applicationForms,
  );
  const applicationResponses = parseApplicationResponses(
    candidate.applicationResponses,
    guildId,
    applications,
  );
  const applicationEvents = parseApplicationEvents(
    candidate.applicationEvents,
    guildId,
    applications,
  );

  return {
    delegatedCapabilityGrants,
    ticketDepartments,
    ticketDepartmentFields,
    postedPanels,
    tickets,
    ticketFormResponses,
    ticketEvents,
    suggestionConfiguration,
    suggestions,
    suggestionVotes,
    suggestionEvents,
    applicationForms,
    applicationFormFields,
    applications,
    applicationResponses,
    applicationEvents,
  };
}

/** Inserts a fully parsed snapshot with every authority/resource binding dormant. */
export function insertPhase2OperationalData(
  db: DatabaseConnection,
  guildId: string,
  imported: Phase2OperationalData,
): void {
  const insertGrant = db.prepare(
    `INSERT INTO delegated_capability_grants (
       guild_id, principal_type, principal_id, capability, active, granted_by,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  );
  for (const grant of imported.delegatedCapabilityGrants) {
    insertGrant.run(
      guildId,
      grant.principalType,
      grant.principalId,
      grant.capability,
      grant.grantedBy,
      grant.createdAt,
      grant.updatedAt,
    );
  }

  const insertDepartment = db.prepare(
    `INSERT INTO ticket_departments (
       guild_id, department_id, slug, display_name, description, emoji,
       category_id, log_channel_id, support_role_id, enabled, sort_order,
       definition_version, bindings_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
  );
  for (const department of imported.ticketDepartments) {
    insertDepartment.run(
      guildId,
      department.departmentId,
      department.slug,
      department.displayName,
      department.description,
      department.emoji,
      department.categoryId,
      department.logChannelId,
      department.supportRoleId,
      department.sortOrder,
      department.definitionVersion,
      department.createdAt,
      department.updatedAt,
    );
  }

  const insertDepartmentField = db.prepare(
    `INSERT INTO ticket_department_fields (
       guild_id, department_id, field_id, label, description, placeholder,
       field_type, required, min_length, max_length, sort_order, created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const field of imported.ticketDepartmentFields) {
    insertDepartmentField.run(
      guildId,
      field.departmentId,
      field.fieldId,
      field.label,
      field.description,
      field.placeholder,
      field.fieldType,
      field.required ? 1 : 0,
      field.minLength,
      field.maxLength,
      field.sortOrder,
      field.createdAt,
      field.updatedAt,
    );
  }

  const insertPanel = db.prepare(
    `INSERT INTO posted_panels (
       guild_id, panel_id, preset, channel_id, message_id, configuration_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const panel of imported.postedPanels) {
    insertPanel.run(
      guildId,
      panel.panelId,
      panel.preset,
      panel.channelId,
      panel.messageId,
      serializeBoundedJson(panel.configuration, 16_000, "panel configuration"),
      panel.createdAt,
      panel.updatedAt,
    );
  }

  const insertTicket = db.prepare(
    `INSERT INTO tickets (
       guild_id, ticket_id, ticket_number, department_id, opener_id, channel_id,
       control_message_id, subject, description, state, claimed_by, claimed_at,
       closed_by, close_reason, close_log_message_id, close_logged_at,
       failure_reason, created_at, updated_at, closing_at, closed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ticket of imported.tickets) {
    insertTicket.run(
      guildId,
      ticket.ticketId,
      ticket.ticketNumber,
      ticket.departmentId,
      ticket.openerId,
      ticket.channelId,
      ticket.controlMessageId,
      ticket.subject,
      ticket.description,
      ticket.state,
      ticket.claimedBy,
      ticket.claimedAt,
      ticket.closedBy,
      ticket.closeReason,
      ticket.closeLogMessageId,
      ticket.closeLoggedAt,
      ticket.failureReason,
      ticket.createdAt,
      ticket.updatedAt,
      ticket.closingAt,
      ticket.closedAt,
    );
  }

  insertTicketResponses(db, guildId, imported.ticketFormResponses);
  insertTicketEvents(db, guildId, imported.ticketEvents);
  insertSuggestions(db, guildId, imported);
  insertApplications(db, guildId, imported);
}

function insertTicketResponses(
  db: DatabaseConnection,
  guildId: string,
  responses: readonly TicketFormResponse[],
): void {
  const insert = db.prepare(
    `INSERT INTO ticket_form_responses (
       guild_id, ticket_id, response_id, field_id, field_label, field_type,
       response_text, sort_order, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const response of responses) {
    insert.run(
      guildId,
      response.ticketId,
      response.responseId,
      response.fieldId,
      response.fieldLabel,
      response.fieldType,
      response.responseText,
      response.sortOrder,
      response.createdAt,
    );
  }
}

function insertTicketEvents(
  db: DatabaseConnection,
  guildId: string,
  events: readonly TicketEvent[],
): void {
  const counts = new Map<string, number>();
  const insert = db.prepare(
    `INSERT INTO ticket_events (
       guild_id, ticket_id, event_id, event_number, event_type, actor_id,
       details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of events) {
    const count = (counts.get(event.ticketId) ?? 0) + 1;
    if (count > MAX_AUDIT_EVENTS_PER_PARENT) {
      throw new RangeError(
        `A ticket can have at most ${MAX_AUDIT_EVENTS_PER_PARENT} imported events`,
      );
    }
    counts.set(event.ticketId, count);
    insert.run(
      guildId,
      event.ticketId,
      event.eventId,
      event.eventNumber,
      event.type,
      event.actorId,
      serializeBoundedJson(event.details, 4_000, "ticket event details"),
      event.createdAt,
    );
  }
}

function insertSuggestions(
  db: DatabaseConnection,
  guildId: string,
  imported: Phase2OperationalData,
): void {
  const configuration = imported.suggestionConfiguration;
  if (configuration) {
    db.prepare(
      `INSERT INTO suggestion_configurations (
         guild_id, enabled, suggestion_channel_id, review_channel_id,
         reviewer_role_id, create_threads, cooldown_limit,
         cooldown_window_seconds, allow_self_votes, bindings_verified_at,
         created_at, updated_at
       ) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      guildId,
      configuration.suggestionChannelId,
      configuration.reviewChannelId,
      configuration.reviewerRoleId,
      configuration.createThreads ? 1 : 0,
      configuration.cooldownLimit,
      configuration.cooldownWindowSeconds,
      configuration.allowSelfVotes ? 1 : 0,
      configuration.createdAt,
      configuration.updatedAt,
    );
  }

  const insertSuggestion = db.prepare(
    `INSERT INTO suggestions (
       guild_id, suggestion_id, suggestion_number, author_id, title, details,
       state, delivery_state, channel_id, message_id, thread_id, reviewer_id,
       review_reason, reviewed_at, withdrawn_at, failure_reason, created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const suggestion of imported.suggestions) {
    insertSuggestion.run(
      guildId,
      suggestion.suggestionId,
      suggestion.suggestionNumber,
      suggestion.authorId,
      suggestion.title,
      suggestion.details,
      suggestion.state,
      suggestion.deliveryState,
      suggestion.channelId,
      suggestion.messageId,
      suggestion.threadId,
      suggestion.reviewerId,
      suggestion.reviewReason,
      suggestion.reviewedAt,
      suggestion.withdrawnAt,
      suggestion.failureReason,
      suggestion.createdAt,
      suggestion.updatedAt,
    );
  }

  const insertVote = db.prepare(
    `INSERT INTO suggestion_votes (
       guild_id, suggestion_id, voter_id, vote, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const vote of imported.suggestionVotes) {
    insertVote.run(
      guildId,
      vote.suggestionId,
      vote.voterId,
      vote.vote,
      vote.createdAt,
      vote.updatedAt,
    );
  }

  const insertEvent = db.prepare(
    `INSERT INTO suggestion_events (
       guild_id, suggestion_id, event_id, event_number, event_type, actor_id,
       details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of imported.suggestionEvents) {
    insertEvent.run(
      guildId,
      event.suggestionId,
      event.eventId,
      event.eventNumber,
      event.type,
      event.actorId,
      serializeBoundedJson(event.details, 4_000, "suggestion event details"),
      event.createdAt,
    );
  }
}

function insertApplications(
  db: DatabaseConnection,
  guildId: string,
  imported: Phase2OperationalData,
): void {
  const insertForm = db.prepare(
    `INSERT INTO application_forms (
       guild_id, form_id, slug, display_name, description, reviewer_role_id,
       review_channel_id, enabled, sort_order, definition_version,
       bindings_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`,
  );
  for (const form of imported.applicationForms) {
    insertForm.run(
      guildId,
      form.formId,
      form.slug,
      form.displayName,
      form.description,
      form.reviewerRoleId,
      form.reviewChannelId,
      form.sortOrder,
      form.definitionVersion,
      form.createdAt,
      form.updatedAt,
    );
  }

  const insertField = db.prepare(
    `INSERT INTO application_form_fields (
       guild_id, form_id, field_id, label, description, placeholder, field_type,
       required, min_length, max_length, sort_order, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const field of imported.applicationFormFields) {
    insertField.run(
      guildId,
      field.formId,
      field.fieldId,
      field.label,
      field.description,
      field.placeholder,
      field.fieldType,
      field.required ? 1 : 0,
      field.minLength,
      field.maxLength,
      field.sortOrder,
      field.createdAt,
      field.updatedAt,
    );
  }

  const insertApplication = db.prepare(
    `INSERT INTO applications (
       guild_id, application_id, application_number, form_id, applicant_id,
       state, delivery_state, review_channel_id, review_message_id, claimed_by,
       claimed_at, decision_by, decision_reason, decided_at, withdrawn_at,
       failure_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const application of imported.applications) {
    insertApplication.run(
      guildId,
      application.applicationId,
      application.applicationNumber,
      application.formId,
      application.applicantId,
      application.state,
      application.deliveryState,
      application.reviewChannelId,
      application.reviewMessageId,
      application.claimedBy,
      application.claimedAt,
      application.decisionBy,
      application.decisionReason,
      application.decidedAt,
      application.withdrawnAt,
      application.failureReason,
      application.createdAt,
      application.updatedAt,
    );
  }

  const insertResponse = db.prepare(
    `INSERT INTO application_responses (
       guild_id, application_id, response_id, field_id, field_label, field_type,
       response_text, sort_order, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const response of imported.applicationResponses) {
    insertResponse.run(
      guildId,
      response.applicationId,
      response.responseId,
      response.fieldId,
      response.fieldLabel,
      response.fieldType,
      response.responseText,
      response.sortOrder,
      response.createdAt,
    );
  }

  const insertEvent = db.prepare(
    `INSERT INTO application_events (
       guild_id, application_id, event_id, event_number, event_type, actor_id,
       details_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const event of imported.applicationEvents) {
    insertEvent.run(
      guildId,
      event.applicationId,
      event.eventId,
      event.eventNumber,
      event.type,
      event.actorId,
      serializeBoundedJson(event.details, 4_000, "application event details"),
      event.createdAt,
    );
  }
}

function parseCapabilityGrants(
  value: unknown,
  guildId: string,
  capabilities: readonly GuildCapability[],
): DelegatedCapabilityGrant[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.delegatedCapabilityGrants,
    "delegatedCapabilityGrants",
  );
  const seen = new Set<string>();
  return rows.map((value): DelegatedCapabilityGrant => {
    const row = requireRecord(value, "Imported delegated capability grant");
    assertImportedGuild(row.guildId, guildId, "capability grant");
    const principalType = requireEnum(
      row.principalType,
      ["role"] as const,
      "capability principal type",
    );
    const principalId = requireSnowflake(
      row.principalId,
      "capability principal ID",
    );
    const capability = requireEnum(
      row.capability,
      capabilities,
      "delegated capability",
    );
    rejectDuplicate(
      seen,
      `${principalType}\u0000${principalId}\u0000${capability}`,
      "delegated capability grant",
    );
    return {
      guildId,
      principalType,
      principalId,
      capability,
      active: requireBoolean(row.active, "capability grant active"),
      grantedBy: requireSnowflake(row.grantedBy, "capability granting user ID"),
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function parseTicketDepartments(
  value: unknown,
  guildId: string,
): TicketDepartment[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.ticketDepartments,
    "ticketDepartments",
  );
  const ids = new Set<string>();
  const slugs = new Set<string>();
  return rows.map((value): TicketDepartment => {
    const row = requireRecord(value, "Imported ticket department");
    assertImportedGuild(row.guildId, guildId, "ticket department");
    const departmentId = requireOpaqueId(
      row.departmentId,
      "ticket department ID",
    );
    const slug = requireSlug(row.slug, "ticket department slug");
    rejectDuplicate(ids, departmentId, "ticket department ID");
    rejectDuplicate(slugs, slug, "ticket department slug");
    const enabled = requireBoolean(row.enabled, "ticket department enabled");
    const categoryId = requireNullableSnowflake(
      row.categoryId,
      "ticket category ID",
    );
    const logChannelId = requireNullableSnowflake(
      row.logChannelId,
      "ticket log channel ID",
    );
    const supportRoleId = requireNullableSnowflake(
      row.supportRoleId,
      "ticket support role ID",
    );
    if (enabled && (!categoryId || !logChannelId || !supportRoleId)) {
      throw new TypeError(
        `Imported enabled ticket department ${departmentId} requires complete routing`,
      );
    }
    return {
      guildId,
      departmentId,
      slug,
      displayName: requireText(
        row.displayName,
        1,
        100,
        "ticket department name",
      ),
      description: requireText(
        row.description,
        1,
        1_000,
        "ticket department description",
      ),
      emoji:
        row.emoji === null
          ? null
          : normalizeUnicodeEmoji(
              row.emoji,
              "Imported ticket department emoji",
            ),
      categoryId,
      logChannelId,
      supportRoleId,
      enabled,
      sortOrder: requireInteger(
        row.sortOrder,
        0,
        9,
        "ticket department sort order",
      ),
      definitionVersion: requireInteger(
        row.definitionVersion,
        1,
        2_147_483_647,
        "ticket department definition version",
      ),
      bindingsVerifiedAt: requireNullableTimestamp(row.bindingsVerifiedAt),
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function parseTicketDepartmentFields(
  value: unknown,
  guildId: string,
  departments: readonly TicketDepartment[],
): TicketDepartmentField[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.ticketDepartmentFields,
    "ticketDepartmentFields",
  );
  const departmentIds = new Set(departments.map((row) => row.departmentId));
  const ids = new Set<string>();
  const orders = new Set<string>();
  const counts = new Map<string, number>();
  return rows.map((value): TicketDepartmentField => {
    const row = requireRecord(value, "Imported ticket department field");
    assertImportedGuild(row.guildId, guildId, "ticket department field");
    const departmentId = requireOpaqueId(
      row.departmentId,
      "field department ID",
    );
    if (!departmentIds.has(departmentId)) {
      throw new TypeError(
        `Imported ticket field references unknown department ${departmentId}`,
      );
    }
    const fieldId = requireOpaqueId(row.fieldId, "ticket field ID");
    const sortOrder = requireInteger(
      row.sortOrder,
      0,
      4,
      "ticket field sort order",
    );
    rejectDuplicate(ids, `${departmentId}\u0000${fieldId}`, "ticket field ID");
    rejectDuplicate(
      orders,
      `${departmentId}\u0000${sortOrder}`,
      "ticket field sort order",
    );
    const count = (counts.get(departmentId) ?? 0) + 1;
    counts.set(departmentId, count);
    if (count > 5)
      throw new RangeError("A ticket department can have at most 5 fields");
    const minLength = requireInteger(
      row.minLength,
      0,
      4_000,
      "ticket field minimum",
    );
    const maxLength = requireInteger(
      row.maxLength,
      1,
      4_000,
      "ticket field maximum",
    );
    if (minLength > maxLength) {
      throw new RangeError("Imported ticket field minimum exceeds its maximum");
    }
    return {
      guildId,
      departmentId,
      fieldId,
      label: requireText(row.label, 1, 45, "ticket field label"),
      description: requireNullableText(
        row.description,
        1,
        100,
        "ticket field description",
      ),
      placeholder: requireNullableText(
        row.placeholder,
        1,
        100,
        "ticket field placeholder",
      ),
      fieldType: requireEnum(
        row.fieldType,
        FORM_FIELD_TYPES,
        "ticket field type",
      ),
      required: requireBoolean(row.required, "ticket field required"),
      minLength,
      maxLength,
      sortOrder,
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

const PHASE2_PANEL_PRESETS = [
  "help",
  "server-info",
  "resources",
  "tickets",
  "suggestions",
  "applications",
] as const satisfies readonly PanelPreset[];

function parsePostedPanels(
  value: unknown,
  guildId: string,
  presets: readonly PanelPreset[],
): PostedPanel[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.postedPanels,
    "postedPanels",
  );
  const ids = new Set<string>();
  const placements = new Set<string>();
  const messages = new Set<string>();
  return rows.map((value): PostedPanel => {
    const row = requireRecord(value, "Imported posted panel");
    assertImportedGuild(row.guildId, guildId, "posted panel");
    const panelId = requireOpaqueId(row.panelId, "posted panel ID");
    const preset = requireEnum(row.preset, presets, "posted panel preset");
    const channelId = requireSnowflake(
      row.channelId,
      "posted panel channel ID",
    );
    const messageId = requireSnowflake(
      row.messageId,
      "posted panel message ID",
    );
    rejectDuplicate(ids, panelId, "posted panel ID");
    rejectDuplicate(
      placements,
      `${preset}\u0000${channelId}`,
      "posted panel placement",
    );
    rejectDuplicate(
      messages,
      `${channelId}\u0000${messageId}`,
      "posted panel message",
    );
    return {
      guildId,
      panelId,
      preset,
      channelId,
      messageId,
      configuration: parseBoundedJson(
        row.configuration,
        16_000,
        "panel configuration",
      ),
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function parseTickets(
  value: unknown,
  guildId: string,
  departments: readonly TicketDepartment[],
): TicketRecord[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.tickets,
    "tickets",
  );
  const departmentIds = new Set(departments.map((row) => row.departmentId));
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const channels = new Set<string>();
  const activePerDepartment = new Set<string>();
  const activePerGuild = new Map<string, number>();
  return rows.map((value): TicketRecord => {
    const row = requireRecord(value, "Imported ticket");
    assertImportedGuild(row.guildId, guildId, "ticket");
    const ticketId = requireOpaqueId(row.ticketId, "ticket ID");
    const ticketNumber = requireInteger(
      row.ticketNumber,
      1,
      2_147_483_647,
      "ticket number",
    );
    const departmentId = requireOpaqueId(
      row.departmentId,
      "ticket department ID",
    );
    if (!departmentIds.has(departmentId)) {
      throw new TypeError(
        `Imported ticket ${ticketId} references unknown department ${departmentId}`,
      );
    }
    const openerId = requireSnowflake(row.openerId, "ticket opener ID");
    const channelId = requireNullableSnowflake(
      row.channelId,
      "ticket channel ID",
    );
    const controlMessageId = requireNullableSnowflake(
      row.controlMessageId,
      "ticket control message ID",
    );
    const state = requireEnum(
      row.state,
      ["creating", "open", "closing", "closed", "failed"] as const,
      "ticket state",
    );
    const claimedBy = requireNullableSnowflake(
      row.claimedBy,
      "ticket claimant ID",
    );
    const claimedAt = requireNullableTimestamp(row.claimedAt);
    const closedBy = requireNullableSnowflake(row.closedBy, "ticket closer ID");
    const closeReason = requireNullableText(
      row.closeReason,
      1,
      500,
      "ticket close reason",
    );
    const closeLogMessageId = requireNullableSnowflake(
      row.closeLogMessageId,
      "ticket close-log message ID",
    );
    const closeLoggedAt = requireNullableTimestamp(row.closeLoggedAt);
    const failureReason = requireNullableText(
      row.failureReason,
      1,
      1_000,
      "ticket failure reason",
    );
    const closingAt = requireNullableTimestamp(row.closingAt);
    const closedAt = requireNullableTimestamp(row.closedAt);
    rejectDuplicate(ids, ticketId, "ticket ID");
    rejectDuplicate(numbers, ticketNumber, "ticket number");
    if (channelId) rejectDuplicate(channels, channelId, "ticket channel");
    if (["creating", "open", "closing"].includes(state)) {
      rejectDuplicate(
        activePerDepartment,
        `${departmentId}\u0000${openerId}`,
        "active ticket opener/department",
      );
      const activeCount = (activePerGuild.get(openerId) ?? 0) + 1;
      activePerGuild.set(openerId, activeCount);
      if (activeCount > 3) {
        throw new RangeError(
          "A guild member can have at most 3 active tickets",
        );
      }
    }
    validateTicketLifecycle({
      ticketId,
      state,
      channelId,
      controlMessageId,
      claimedBy,
      claimedAt,
      closedBy,
      closeReason,
      closeLogMessageId,
      closeLoggedAt,
      failureReason,
      closingAt,
      closedAt,
    });
    return {
      guildId,
      ticketId,
      ticketNumber,
      departmentId,
      openerId,
      channelId,
      controlMessageId,
      subject: requireText(row.subject, 1, 100, "ticket subject"),
      description: requireText(row.description, 1, 2_000, "ticket description"),
      state,
      claimedBy,
      claimedAt,
      closedBy,
      closeReason,
      closeLogMessageId,
      closeLoggedAt,
      failureReason,
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
      closingAt,
      closedAt,
    };
  });
}

function validateTicketLifecycle(input: {
  ticketId: string;
  state: TicketRecord["state"];
  channelId: string | null;
  controlMessageId: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
  closeLogMessageId: string | null;
  closeLoggedAt: string | null;
  failureReason: string | null;
  closingAt: string | null;
  closedAt: string | null;
}): void {
  const { ticketId, state } = input;
  if ((input.claimedBy === null) !== (input.claimedAt === null)) {
    throw new TypeError(
      `Imported ticket ${ticketId} has inconsistent claim data`,
    );
  }
  if (input.controlMessageId !== null && input.channelId === null) {
    throw new TypeError(
      `Imported ticket ${ticketId} has a control message without a channel`,
    );
  }
  if (!["creating", "failed"].includes(state) && input.channelId === null) {
    throw new TypeError(`Imported ticket ${ticketId} requires a channel`);
  }
  if ((state === "failed") !== (input.failureReason !== null)) {
    throw new TypeError(
      `Imported ticket ${ticketId} has inconsistent failure data`,
    );
  }
  if (["closing", "closed"].includes(state) !== (input.closingAt !== null)) {
    throw new TypeError(
      `Imported ticket ${ticketId} has inconsistent closing time`,
    );
  }
  if ((state === "closed") !== (input.closedAt !== null)) {
    throw new TypeError(
      `Imported ticket ${ticketId} has inconsistent closed time`,
    );
  }
  if (
    ["closing", "closed"].includes(state) !==
    (input.closedBy !== null && input.closeReason !== null)
  ) {
    throw new TypeError(
      `Imported ticket ${ticketId} has inconsistent closure data`,
    );
  }
  if ((input.closeLogMessageId === null) !== (input.closeLoggedAt === null)) {
    throw new TypeError(
      `Imported ticket ${ticketId} has inconsistent closure-log data`,
    );
  }
  if (input.closeLoggedAt !== null && !["closing", "closed"].includes(state)) {
    throw new TypeError(
      `Imported ticket ${ticketId} has a closure log outside closing state`,
    );
  }
  if (state === "closed" && input.closeLoggedAt === null) {
    throw new TypeError(
      `Imported closed ticket ${ticketId} has no closure-log checkpoint`,
    );
  }
}

function parseTicketResponses(
  value: unknown,
  guildId: string,
  tickets: readonly TicketRecord[],
): TicketFormResponse[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.ticketFormResponses,
    "ticketFormResponses",
  );
  const ticketIds = new Set(tickets.map((row) => row.ticketId));
  const responseIds = new Set<string>();
  const fieldIds = new Set<string>();
  const orders = new Set<string>();
  const counts = new Map<string, number>();
  return rows.map((value): TicketFormResponse => {
    const row = requireRecord(value, "Imported ticket form response");
    assertImportedGuild(row.guildId, guildId, "ticket form response");
    const ticketId = requireOpaqueId(row.ticketId, "response ticket ID");
    if (!ticketIds.has(ticketId)) {
      throw new TypeError(
        `Imported ticket response references unknown ticket ${ticketId}`,
      );
    }
    const responseId = requireOpaqueId(row.responseId, "ticket response ID");
    const fieldId = requireOpaqueId(row.fieldId, "ticket response field ID");
    const sortOrder = requireInteger(
      row.sortOrder,
      0,
      4,
      "ticket response order",
    );
    rejectDuplicate(
      responseIds,
      `${ticketId}\u0000${responseId}`,
      "ticket response ID",
    );
    rejectDuplicate(
      fieldIds,
      `${ticketId}\u0000${fieldId}`,
      "ticket response field",
    );
    rejectDuplicate(
      orders,
      `${ticketId}\u0000${sortOrder}`,
      "ticket response order",
    );
    const count = (counts.get(ticketId) ?? 0) + 1;
    counts.set(ticketId, count);
    if (count > 5)
      throw new RangeError("A ticket can have at most 5 form responses");
    return {
      guildId,
      ticketId,
      responseId,
      fieldId,
      fieldLabel: requireText(row.fieldLabel, 1, 45, "ticket response label"),
      fieldType: requireEnum(
        row.fieldType,
        FORM_FIELD_TYPES,
        "ticket response type",
      ),
      responseText: requireText(
        row.responseText,
        0,
        4_000,
        "ticket response text",
      ),
      sortOrder,
      createdAt: requireTimestamp(row.createdAt),
    };
  });
}

function parseTicketEvents(
  value: unknown,
  guildId: string,
  tickets: readonly TicketRecord[],
): TicketEvent[] {
  return parseEvents<TicketEvent>({
    value,
    guildId,
    collection: "ticketEvents",
    maximum: PHASE2_COLLECTION_LIMITS.ticketEvents,
    parentIds: new Set(tickets.map((row) => row.ticketId)),
    parentKey: "ticketId",
    parentLabel: "ticket",
    eventTypes: [
      "creation_reserved",
      "creation_activated",
      "creation_failed",
      "claimed",
      "released",
      "close_started",
      "close_logged",
      "close_failed",
      "closed",
      "rebound",
      "recovery_noted",
    ] as const,
    perParentMaximum: MAX_AUDIT_EVENTS_PER_PARENT,
  });
}

function parseSuggestionConfiguration(
  value: unknown,
  guildId: string,
): SuggestionConfiguration | null {
  if (value === null) return null;
  const row = requireRecord(value, "Imported suggestion configuration");
  assertImportedGuild(row.guildId, guildId, "suggestion configuration");
  return {
    guildId,
    enabled: requireBoolean(row.enabled, "suggestion configuration enabled"),
    suggestionChannelId: requireSnowflake(
      row.suggestionChannelId,
      "suggestion channel ID",
    ),
    reviewChannelId: requireNullableSnowflake(
      row.reviewChannelId,
      "suggestion review channel ID",
    ),
    reviewerRoleId: requireSnowflake(
      row.reviewerRoleId,
      "suggestion reviewer role ID",
    ),
    createThreads: requireBoolean(
      row.createThreads,
      "suggestion thread setting",
    ),
    cooldownLimit: requireInteger(
      row.cooldownLimit,
      1,
      10,
      "suggestion cooldown limit",
    ),
    cooldownWindowSeconds: requireInteger(
      row.cooldownWindowSeconds,
      60,
      86_400,
      "suggestion cooldown window",
    ),
    allowSelfVotes: requireBoolean(
      row.allowSelfVotes,
      "suggestion self-vote setting",
    ),
    bindingsVerifiedAt: requireNullableTimestamp(row.bindingsVerifiedAt),
    createdAt: requireTimestamp(row.createdAt),
    updatedAt: requireTimestamp(row.updatedAt),
  };
}

function parseSuggestions(value: unknown, guildId: string): SuggestionRecord[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.suggestions,
    "suggestions",
  );
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const messages = new Set<string>();
  return rows.map((value): SuggestionRecord => {
    const row = requireRecord(value, "Imported suggestion");
    assertImportedGuild(row.guildId, guildId, "suggestion");
    const suggestionId = requireOpaqueId(row.suggestionId, "suggestion ID");
    const suggestionNumber = requireInteger(
      row.suggestionNumber,
      1,
      2_147_483_647,
      "suggestion number",
    );
    const state = requireEnum(row.state, SUGGESTION_STATES, "suggestion state");
    const deliveryState = requireEnum(
      row.deliveryState,
      DELIVERY_STATES,
      "suggestion delivery state",
    );
    const channelId = requireNullableSnowflake(
      row.channelId,
      "suggestion channel ID",
    );
    const messageId = requireNullableSnowflake(
      row.messageId,
      "suggestion message ID",
    );
    const threadId = requireNullableSnowflake(
      row.threadId,
      "suggestion thread ID",
    );
    const reviewerId = requireNullableSnowflake(
      row.reviewerId,
      "suggestion reviewer ID",
    );
    const reviewReason = requireNullableText(
      row.reviewReason,
      1,
      1_000,
      "suggestion review reason",
    );
    const reviewedAt = requireNullableTimestamp(row.reviewedAt);
    const withdrawnAt = requireNullableTimestamp(row.withdrawnAt);
    const failureReason = requireNullableText(
      row.failureReason,
      1,
      1_000,
      "suggestion failure reason",
    );
    rejectDuplicate(ids, suggestionId, "suggestion ID");
    rejectDuplicate(numbers, suggestionNumber, "suggestion number");
    if (messageId && channelId) {
      rejectDuplicate(
        messages,
        `${channelId}\u0000${messageId}`,
        "suggestion message",
      );
    }
    if ((messageId === null) !== (channelId === null)) {
      throw new TypeError(
        `Imported suggestion ${suggestionId} has incomplete delivery IDs`,
      );
    }
    if (threadId !== null && messageId === null) {
      throw new TypeError(
        `Imported suggestion ${suggestionId} has a thread without a message`,
      );
    }
    if (
      ["posted", "missing"].includes(deliveryState) !==
      (messageId !== null)
    ) {
      throw new TypeError(
        `Imported suggestion ${suggestionId} has inconsistent delivery state`,
      );
    }
    if ((deliveryState === "failed") !== (failureReason !== null)) {
      throw new TypeError(
        `Imported suggestion ${suggestionId} has inconsistent failure data`,
      );
    }
    const reviewedState = [
      "under-review",
      "accepted",
      "declined",
      "implemented",
    ].includes(state);
    if (
      reviewedState !==
      (reviewerId !== null && reviewReason !== null && reviewedAt !== null)
    ) {
      throw new TypeError(
        `Imported suggestion ${suggestionId} has inconsistent review data`,
      );
    }
    if ((state === "withdrawn") !== (withdrawnAt !== null)) {
      throw new TypeError(
        `Imported suggestion ${suggestionId} has inconsistent withdrawal data`,
      );
    }
    return {
      guildId,
      suggestionId,
      suggestionNumber,
      authorId: requireSnowflake(row.authorId, "suggestion author ID"),
      title: requireText(row.title, 1, 100, "suggestion title"),
      details: requireText(row.details, 1, 4_000, "suggestion details"),
      state,
      deliveryState,
      channelId,
      messageId,
      threadId,
      reviewerId,
      reviewReason,
      reviewedAt,
      withdrawnAt,
      failureReason,
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function parseSuggestionVotes(
  value: unknown,
  guildId: string,
  suggestions: readonly SuggestionRecord[],
): SuggestionVote[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.suggestionVotes,
    "suggestionVotes",
  );
  const suggestionIds = new Set(suggestions.map((row) => row.suggestionId));
  const seen = new Set<string>();
  return rows.map((value): SuggestionVote => {
    const row = requireRecord(value, "Imported suggestion vote");
    assertImportedGuild(row.guildId, guildId, "suggestion vote");
    const suggestionId = requireOpaqueId(
      row.suggestionId,
      "vote suggestion ID",
    );
    if (!suggestionIds.has(suggestionId)) {
      throw new TypeError(
        `Imported vote references unknown suggestion ${suggestionId}`,
      );
    }
    const voterId = requireSnowflake(row.voterId, "suggestion voter ID");
    rejectDuplicate(seen, `${suggestionId}\u0000${voterId}`, "suggestion vote");
    const vote = requireInteger(row.vote, -1, 1, "suggestion vote");
    if (vote !== -1 && vote !== 1) {
      throw new RangeError("Imported suggestion vote must be -1 or 1");
    }
    return {
      guildId,
      suggestionId,
      voterId,
      vote,
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function parseSuggestionEvents(
  value: unknown,
  guildId: string,
  suggestions: readonly SuggestionRecord[],
): SuggestionEvent[] {
  return parseEvents<SuggestionEvent>({
    value,
    guildId,
    collection: "suggestionEvents",
    maximum: PHASE2_COLLECTION_LIMITS.suggestionEvents,
    parentIds: new Set(suggestions.map((row) => row.suggestionId)),
    parentKey: "suggestionId",
    parentLabel: "suggestion",
    eventTypes: SUGGESTION_EVENT_TYPES,
    perParentMaximum: MAX_AUDIT_EVENTS_PER_PARENT,
  });
}

function parseApplicationForms(
  value: unknown,
  guildId: string,
): ApplicationForm[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.applicationForms,
    "applicationForms",
  );
  const ids = new Set<string>();
  const slugs = new Set<string>();
  return rows.map((value): ApplicationForm => {
    const row = requireRecord(value, "Imported application form");
    assertImportedGuild(row.guildId, guildId, "application form");
    const formId = requireOpaqueId(row.formId, "application form ID");
    const slug = requireSlug(row.slug, "application form slug");
    rejectDuplicate(ids, formId, "application form ID");
    rejectDuplicate(slugs, slug, "application form slug");
    return {
      guildId,
      formId,
      slug,
      displayName: requireText(
        row.displayName,
        1,
        100,
        "application form name",
      ),
      description: requireText(
        row.description,
        1,
        1_000,
        "application form description",
      ),
      reviewerRoleId: requireSnowflake(
        row.reviewerRoleId,
        "application reviewer role ID",
      ),
      reviewChannelId: requireSnowflake(
        row.reviewChannelId,
        "application review channel ID",
      ),
      enabled: requireBoolean(row.enabled, "application form enabled"),
      sortOrder: requireInteger(
        row.sortOrder,
        0,
        24,
        "application form sort order",
      ),
      definitionVersion: requireInteger(
        row.definitionVersion,
        1,
        2_147_483_647,
        "application form definition version",
      ),
      bindingsVerifiedAt: requireNullableTimestamp(row.bindingsVerifiedAt),
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function parseApplicationFormFields(
  value: unknown,
  guildId: string,
  forms: readonly ApplicationForm[],
): ApplicationFormField[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.applicationFormFields,
    "applicationFormFields",
  );
  const formIds = new Set(forms.map((row) => row.formId));
  const ids = new Set<string>();
  const orders = new Set<string>();
  const counts = new Map<string, number>();
  return rows.map((value): ApplicationFormField => {
    const row = requireRecord(value, "Imported application form field");
    assertImportedGuild(row.guildId, guildId, "application form field");
    const formId = requireOpaqueId(row.formId, "field application form ID");
    if (!formIds.has(formId)) {
      throw new TypeError(
        `Imported application field references unknown form ${formId}`,
      );
    }
    const fieldId = requireOpaqueId(row.fieldId, "application field ID");
    const sortOrder = requireInteger(
      row.sortOrder,
      0,
      4,
      "application field sort order",
    );
    rejectDuplicate(ids, `${formId}\u0000${fieldId}`, "application field ID");
    rejectDuplicate(
      orders,
      `${formId}\u0000${sortOrder}`,
      "application field order",
    );
    const count = (counts.get(formId) ?? 0) + 1;
    counts.set(formId, count);
    if (count > 5)
      throw new RangeError("An application form can have at most 5 fields");
    const minLength = requireInteger(
      row.minLength,
      0,
      4_000,
      "application field minimum",
    );
    const maxLength = requireInteger(
      row.maxLength,
      1,
      4_000,
      "application field maximum",
    );
    if (minLength > maxLength) {
      throw new RangeError(
        "Imported application field minimum exceeds its maximum",
      );
    }
    return {
      guildId,
      formId,
      fieldId,
      label: requireText(row.label, 1, 45, "application field label"),
      description: requireNullableText(
        row.description,
        1,
        100,
        "application field description",
      ),
      placeholder: requireNullableText(
        row.placeholder,
        1,
        100,
        "application field placeholder",
      ),
      fieldType: requireEnum(
        row.fieldType,
        FORM_FIELD_TYPES,
        "application field type",
      ),
      required: requireBoolean(row.required, "application field required"),
      minLength,
      maxLength,
      sortOrder,
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function validateEnabledApplicationForms(
  forms: readonly ApplicationForm[],
  fields: readonly ApplicationFormField[],
): void {
  const counts = new Map<string, number>();
  for (const field of fields) {
    counts.set(field.formId, (counts.get(field.formId) ?? 0) + 1);
  }
  for (const form of forms) {
    if (
      form.enabled &&
      ((counts.get(form.formId) ?? 0) < 1 || (counts.get(form.formId) ?? 0) > 5)
    ) {
      throw new TypeError(
        `Imported enabled application form ${form.formId} requires 1-5 fields`,
      );
    }
  }
}

function parseApplications(
  value: unknown,
  guildId: string,
  forms: readonly ApplicationForm[],
): ApplicationRecord[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.applications,
    "applications",
  );
  const formIds = new Set(forms.map((row) => row.formId));
  const ids = new Set<string>();
  const numbers = new Set<number>();
  const messages = new Set<string>();
  const activeApplicants = new Set<string>();
  return rows.map((value): ApplicationRecord => {
    const row = requireRecord(value, "Imported application");
    assertImportedGuild(row.guildId, guildId, "application");
    const applicationId = requireOpaqueId(row.applicationId, "application ID");
    const applicationNumber = requireInteger(
      row.applicationNumber,
      1,
      2_147_483_647,
      "application number",
    );
    const formId = requireOpaqueId(row.formId, "application form ID");
    if (!formIds.has(formId)) {
      throw new TypeError(
        `Imported application references unknown form ${formId}`,
      );
    }
    const applicantId = requireSnowflake(
      row.applicantId,
      "application applicant ID",
    );
    const state = requireEnum(
      row.state,
      APPLICATION_STATES,
      "application state",
    );
    const deliveryState = requireEnum(
      row.deliveryState,
      DELIVERY_STATES,
      "application delivery state",
    );
    const reviewChannelId = requireNullableSnowflake(
      row.reviewChannelId,
      "application review channel ID",
    );
    const reviewMessageId = requireNullableSnowflake(
      row.reviewMessageId,
      "application review message ID",
    );
    const claimedBy = requireNullableSnowflake(
      row.claimedBy,
      "application claimant ID",
    );
    const claimedAt = requireNullableTimestamp(row.claimedAt);
    const decisionBy = requireNullableSnowflake(
      row.decisionBy,
      "application decider ID",
    );
    const decisionReason = requireNullableText(
      row.decisionReason,
      1,
      1_000,
      "application decision reason",
    );
    const decidedAt = requireNullableTimestamp(row.decidedAt);
    const withdrawnAt = requireNullableTimestamp(row.withdrawnAt);
    const failureReason = requireNullableText(
      row.failureReason,
      1,
      1_000,
      "application failure reason",
    );
    rejectDuplicate(ids, applicationId, "application ID");
    rejectDuplicate(numbers, applicationNumber, "application number");
    if (reviewChannelId && reviewMessageId) {
      rejectDuplicate(
        messages,
        `${reviewChannelId}\u0000${reviewMessageId}`,
        "application review message",
      );
    }
    if (["submitted", "under-review"].includes(state)) {
      rejectDuplicate(
        activeApplicants,
        `${formId}\u0000${applicantId}`,
        "active application applicant/form",
      );
    }
    if ((reviewMessageId === null) !== (reviewChannelId === null)) {
      throw new TypeError(
        `Imported application ${applicationId} has incomplete delivery IDs`,
      );
    }
    if (
      ["posted", "missing"].includes(deliveryState) !==
      (reviewMessageId !== null)
    ) {
      throw new TypeError(
        `Imported application ${applicationId} has inconsistent delivery state`,
      );
    }
    if ((deliveryState === "failed") !== (failureReason !== null)) {
      throw new TypeError(
        `Imported application ${applicationId} has inconsistent failure data`,
      );
    }
    if ((claimedBy === null) !== (claimedAt === null)) {
      throw new TypeError(
        `Imported application ${applicationId} has inconsistent claim data`,
      );
    }
    if (state === "under-review" && claimedBy === null) {
      throw new TypeError(
        `Imported application ${applicationId} is unclaimed under review`,
      );
    }
    const decided = ["accepted", "rejected"].includes(state);
    if (
      decided !==
      (decisionBy !== null && decisionReason !== null && decidedAt !== null)
    ) {
      throw new TypeError(
        `Imported application ${applicationId} has inconsistent decision data`,
      );
    }
    if ((state === "withdrawn") !== (withdrawnAt !== null)) {
      throw new TypeError(
        `Imported application ${applicationId} has inconsistent withdrawal data`,
      );
    }
    return {
      guildId,
      applicationId,
      applicationNumber,
      formId,
      applicantId,
      state,
      deliveryState,
      reviewChannelId,
      reviewMessageId,
      claimedBy,
      claimedAt,
      decisionBy,
      decisionReason,
      decidedAt,
      withdrawnAt,
      failureReason,
      createdAt: requireTimestamp(row.createdAt),
      updatedAt: requireTimestamp(row.updatedAt),
    };
  });
}

function parseApplicationResponses(
  value: unknown,
  guildId: string,
  applications: readonly ApplicationRecord[],
): ApplicationResponse[] {
  const rows = requireBoundedArray(
    value,
    PHASE2_COLLECTION_LIMITS.applicationResponses,
    "applicationResponses",
  );
  const applicationIds = new Set(applications.map((row) => row.applicationId));
  const responseIds = new Set<string>();
  const fieldIds = new Set<string>();
  const orders = new Set<string>();
  const counts = new Map<string, number>();
  return rows.map((value): ApplicationResponse => {
    const row = requireRecord(value, "Imported application response");
    assertImportedGuild(row.guildId, guildId, "application response");
    const applicationId = requireOpaqueId(
      row.applicationId,
      "response application ID",
    );
    if (!applicationIds.has(applicationId)) {
      throw new TypeError(
        `Imported application response references unknown application ${applicationId}`,
      );
    }
    const responseId = requireOpaqueId(
      row.responseId,
      "application response ID",
    );
    const fieldId = requireOpaqueId(
      row.fieldId,
      "application response field ID",
    );
    const sortOrder = requireInteger(
      row.sortOrder,
      0,
      4,
      "application response order",
    );
    rejectDuplicate(
      responseIds,
      `${applicationId}\u0000${responseId}`,
      "application response ID",
    );
    rejectDuplicate(
      fieldIds,
      `${applicationId}\u0000${fieldId}`,
      "application response field",
    );
    rejectDuplicate(
      orders,
      `${applicationId}\u0000${sortOrder}`,
      "application response order",
    );
    const count = (counts.get(applicationId) ?? 0) + 1;
    counts.set(applicationId, count);
    if (count > 5)
      throw new RangeError("An application can have at most 5 responses");
    return {
      guildId,
      applicationId,
      responseId,
      fieldId,
      fieldLabel: requireText(
        row.fieldLabel,
        1,
        45,
        "application response label",
      ),
      fieldType: requireEnum(
        row.fieldType,
        FORM_FIELD_TYPES,
        "application response type",
      ),
      responseText: requireText(
        row.responseText,
        0,
        4_000,
        "application response text",
      ),
      sortOrder,
      createdAt: requireTimestamp(row.createdAt),
    };
  });
}

function parseApplicationEvents(
  value: unknown,
  guildId: string,
  applications: readonly ApplicationRecord[],
): ApplicationEvent[] {
  return parseEvents<ApplicationEvent>({
    value,
    guildId,
    collection: "applicationEvents",
    maximum: PHASE2_COLLECTION_LIMITS.applicationEvents,
    parentIds: new Set(applications.map((row) => row.applicationId)),
    parentKey: "applicationId",
    parentLabel: "application",
    eventTypes: APPLICATION_EVENT_TYPES,
    perParentMaximum: MAX_AUDIT_EVENTS_PER_PARENT,
  });
}

function parseEvents<
  T extends TicketEvent | SuggestionEvent | ApplicationEvent,
>(input: {
  value: unknown;
  guildId: string;
  collection: string;
  maximum: number;
  parentIds: ReadonlySet<string>;
  parentKey: "ticketId" | "suggestionId" | "applicationId";
  parentLabel: string;
  eventTypes: readonly string[];
  perParentMaximum?: number;
}): T[] {
  const rows = requireBoundedArray(
    input.value,
    input.maximum,
    input.collection,
  );
  const eventIds = new Set<string>();
  const eventNumbers = new Set<string>();
  const parentCounts = new Map<string, number>();
  return rows.map((value): T => {
    const row = requireRecord(value, `Imported ${input.parentLabel} event`);
    assertImportedGuild(
      row.guildId,
      input.guildId,
      `${input.parentLabel} event`,
    );
    const parentId = requireOpaqueId(
      row[input.parentKey],
      `event ${input.parentLabel} ID`,
    );
    if (!input.parentIds.has(parentId)) {
      throw new TypeError(
        `Imported ${input.parentLabel} event references unknown ${input.parentLabel} ${parentId}`,
      );
    }
    const parentCount = (parentCounts.get(parentId) ?? 0) + 1;
    parentCounts.set(parentId, parentCount);
    if (
      input.perParentMaximum !== undefined &&
      parentCount > input.perParentMaximum
    ) {
      throw new RangeError(
        `An imported ${input.parentLabel} can have at most ${input.perParentMaximum} audit events`,
      );
    }
    const eventId = requireOpaqueId(
      row.eventId,
      `${input.parentLabel} event ID`,
    );
    const eventNumber = requireInteger(
      row.eventNumber,
      1,
      2_147_483_647,
      `${input.parentLabel} event number`,
    );
    rejectDuplicate(
      eventIds,
      `${parentId}\u0000${eventId}`,
      `${input.parentLabel} event ID`,
    );
    rejectDuplicate(
      eventNumbers,
      `${parentId}\u0000${eventNumber}`,
      `${input.parentLabel} event number`,
    );
    return {
      guildId: input.guildId,
      [input.parentKey]: parentId,
      eventId,
      eventNumber,
      type: requireEnum(
        row.type,
        input.eventTypes,
        `${input.parentLabel} event type`,
      ),
      actorId: requireNullableSnowflake(
        row.actorId,
        `${input.parentLabel} event actor ID`,
      ),
      details: parseBoundedJson(
        row.details,
        4_000,
        `${input.parentLabel} event details`,
      ),
      createdAt: requireTimestamp(row.createdAt),
    } as unknown as T;
  });
}

function mapCapabilityGrant(
  row: Record<string, unknown>,
): DelegatedCapabilityGrant {
  return {
    guildId: text(row.guild_id),
    principalType: text(
      row.principal_type,
    ) as DelegatedCapabilityGrant["principalType"],
    principalId: text(row.principal_id),
    capability: text(row.capability) as DelegatedCapabilityGrant["capability"],
    active: bool(row.active),
    grantedBy: text(row.granted_by),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapTicketDepartment(row: Record<string, unknown>): TicketDepartment {
  return {
    guildId: text(row.guild_id),
    departmentId: text(row.department_id),
    slug: text(row.slug),
    displayName: text(row.display_name),
    description: text(row.description),
    emoji: nullableText(row.emoji),
    categoryId: nullableText(row.category_id),
    logChannelId: nullableText(row.log_channel_id),
    supportRoleId: nullableText(row.support_role_id),
    enabled: bool(row.enabled),
    sortOrder: number(row.sort_order),
    definitionVersion: number(row.definition_version),
    bindingsVerifiedAt: nullableText(row.bindings_verified_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapTicketDepartmentField(
  row: Record<string, unknown>,
): TicketDepartmentField {
  return {
    guildId: text(row.guild_id),
    departmentId: text(row.department_id),
    fieldId: text(row.field_id),
    label: text(row.label),
    description: nullableText(row.description),
    placeholder: nullableText(row.placeholder),
    fieldType: text(row.field_type) as TicketDepartmentField["fieldType"],
    required: bool(row.required),
    minLength: number(row.min_length),
    maxLength: number(row.max_length),
    sortOrder: number(row.sort_order),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapPostedPanel(row: Record<string, unknown>): PostedPanel {
  return {
    guildId: text(row.guild_id),
    panelId: text(row.panel_id),
    preset: text(row.preset) as PostedPanel["preset"],
    channelId: text(row.channel_id),
    messageId: text(row.message_id),
    configuration: JSON.parse(text(row.configuration_json)) as unknown,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapTicket(row: Record<string, unknown>): TicketRecord {
  return {
    guildId: text(row.guild_id),
    ticketId: text(row.ticket_id),
    ticketNumber: number(row.ticket_number),
    departmentId: text(row.department_id),
    openerId: text(row.opener_id),
    channelId: nullableText(row.channel_id),
    controlMessageId: nullableText(row.control_message_id),
    subject: text(row.subject),
    description: text(row.description),
    state: text(row.state) as TicketRecord["state"],
    claimedBy: nullableText(row.claimed_by),
    claimedAt: nullableText(row.claimed_at),
    closedBy: nullableText(row.closed_by),
    closeReason: nullableText(row.close_reason),
    closeLogMessageId: nullableText(row.close_log_message_id),
    closeLoggedAt: nullableText(row.close_logged_at),
    failureReason: nullableText(row.failure_reason),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    closingAt: nullableText(row.closing_at),
    closedAt: nullableText(row.closed_at),
  };
}

function mapTicketResponse(row: Record<string, unknown>): TicketFormResponse {
  return {
    guildId: text(row.guild_id),
    ticketId: text(row.ticket_id),
    responseId: text(row.response_id),
    fieldId: text(row.field_id),
    fieldLabel: text(row.field_label),
    fieldType: text(row.field_type) as TicketFormResponse["fieldType"],
    responseText: text(row.response_text),
    sortOrder: number(row.sort_order),
    createdAt: text(row.created_at),
  };
}

function mapTicketEvent(row: Record<string, unknown>): TicketEvent {
  return {
    guildId: text(row.guild_id),
    ticketId: text(row.ticket_id),
    eventId: text(row.event_id),
    eventNumber: number(row.event_number),
    type: text(row.event_type) as TicketEvent["type"],
    actorId: nullableText(row.actor_id),
    details: JSON.parse(text(row.details_json)) as unknown,
    createdAt: text(row.created_at),
  };
}

function mapSuggestionConfiguration(
  row: Record<string, unknown>,
): SuggestionConfiguration {
  return {
    guildId: text(row.guild_id),
    enabled: bool(row.enabled),
    suggestionChannelId: text(row.suggestion_channel_id),
    reviewChannelId: nullableText(row.review_channel_id),
    reviewerRoleId: text(row.reviewer_role_id),
    createThreads: bool(row.create_threads),
    cooldownLimit: number(row.cooldown_limit),
    cooldownWindowSeconds: number(row.cooldown_window_seconds),
    allowSelfVotes: bool(row.allow_self_votes),
    bindingsVerifiedAt: nullableText(row.bindings_verified_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapSuggestion(row: Record<string, unknown>): SuggestionRecord {
  return {
    guildId: text(row.guild_id),
    suggestionId: text(row.suggestion_id),
    suggestionNumber: number(row.suggestion_number),
    authorId: text(row.author_id),
    title: text(row.title),
    details: text(row.details),
    state: text(row.state) as SuggestionRecord["state"],
    deliveryState: text(
      row.delivery_state,
    ) as SuggestionRecord["deliveryState"],
    channelId: nullableText(row.channel_id),
    messageId: nullableText(row.message_id),
    threadId: nullableText(row.thread_id),
    reviewerId: nullableText(row.reviewer_id),
    reviewReason: nullableText(row.review_reason),
    reviewedAt: nullableText(row.reviewed_at),
    withdrawnAt: nullableText(row.withdrawn_at),
    failureReason: nullableText(row.failure_reason),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapSuggestionVote(row: Record<string, unknown>): SuggestionVote {
  return {
    guildId: text(row.guild_id),
    suggestionId: text(row.suggestion_id),
    voterId: text(row.voter_id),
    vote: number(row.vote) as SuggestionVote["vote"],
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapSuggestionEvent(row: Record<string, unknown>): SuggestionEvent {
  return {
    guildId: text(row.guild_id),
    suggestionId: text(row.suggestion_id),
    eventId: text(row.event_id),
    eventNumber: number(row.event_number),
    type: text(row.event_type) as SuggestionEvent["type"],
    actorId: nullableText(row.actor_id),
    details: JSON.parse(text(row.details_json)) as unknown,
    createdAt: text(row.created_at),
  };
}

function mapApplicationForm(row: Record<string, unknown>): ApplicationForm {
  return {
    guildId: text(row.guild_id),
    formId: text(row.form_id),
    slug: text(row.slug),
    displayName: text(row.display_name),
    description: text(row.description),
    reviewerRoleId: text(row.reviewer_role_id),
    reviewChannelId: text(row.review_channel_id),
    enabled: bool(row.enabled),
    sortOrder: number(row.sort_order),
    definitionVersion: number(row.definition_version),
    bindingsVerifiedAt: nullableText(row.bindings_verified_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapApplicationFormField(
  row: Record<string, unknown>,
): ApplicationFormField {
  return {
    guildId: text(row.guild_id),
    formId: text(row.form_id),
    fieldId: text(row.field_id),
    label: text(row.label),
    description: nullableText(row.description),
    placeholder: nullableText(row.placeholder),
    fieldType: text(row.field_type) as ApplicationFormField["fieldType"],
    required: bool(row.required),
    minLength: number(row.min_length),
    maxLength: number(row.max_length),
    sortOrder: number(row.sort_order),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapApplication(row: Record<string, unknown>): ApplicationRecord {
  return {
    guildId: text(row.guild_id),
    applicationId: text(row.application_id),
    applicationNumber: number(row.application_number),
    formId: text(row.form_id),
    applicantId: text(row.applicant_id),
    state: text(row.state) as ApplicationRecord["state"],
    deliveryState: text(
      row.delivery_state,
    ) as ApplicationRecord["deliveryState"],
    reviewChannelId: nullableText(row.review_channel_id),
    reviewMessageId: nullableText(row.review_message_id),
    claimedBy: nullableText(row.claimed_by),
    claimedAt: nullableText(row.claimed_at),
    decisionBy: nullableText(row.decision_by),
    decisionReason: nullableText(row.decision_reason),
    decidedAt: nullableText(row.decided_at),
    withdrawnAt: nullableText(row.withdrawn_at),
    failureReason: nullableText(row.failure_reason),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function mapApplicationResponse(
  row: Record<string, unknown>,
): ApplicationResponse {
  return {
    guildId: text(row.guild_id),
    applicationId: text(row.application_id),
    responseId: text(row.response_id),
    fieldId: text(row.field_id),
    fieldLabel: text(row.field_label),
    fieldType: text(row.field_type) as ApplicationResponse["fieldType"],
    responseText: text(row.response_text),
    sortOrder: number(row.sort_order),
    createdAt: text(row.created_at),
  };
}

function mapApplicationEvent(row: Record<string, unknown>): ApplicationEvent {
  return {
    guildId: text(row.guild_id),
    applicationId: text(row.application_id),
    eventId: text(row.event_id),
    eventNumber: number(row.event_number),
    type: text(row.event_type) as ApplicationEvent["type"],
    actorId: nullableText(row.actor_id),
    details: JSON.parse(text(row.details_json)) as unknown,
    createdAt: text(row.created_at),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoundedArray(
  value: unknown,
  maximum: number,
  label: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Guild import ${label} must be an array`);
  }
  if (value.length > maximum) {
    throw new RangeError(`Guild import ${label} exceeds ${maximum} records`);
  }
  return value;
}

function assertImportedGuild(
  value: unknown,
  guildId: string,
  label: string,
): void {
  if (value !== guildId) {
    throw new TypeError(`Imported ${label} must belong to the current guild`);
  }
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`Imported ${label} must be boolean`);
  return value;
}

function requireSnowflake(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Imported ${label} must be a Discord snowflake`);
  }
  return assertDiscordSnowflake(value, label);
}

function requireNullableSnowflake(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : requireSnowflake(value, label);
}

function requireOpaqueId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 24 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new TypeError(
      `Imported ${label} must be an 8-24 character opaque token`,
    );
  }
  return value;
}

function requireSlug(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 32 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value) ||
    value.includes("--")
  ) {
    throw new TypeError(`Imported ${label} is invalid`);
  }
  return value;
}

function requireText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string")
    throw new TypeError(`Imported ${label} must be text`);
  const normalized = value.normalize("NFKC").trim();
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`Imported ${label} cannot contain control characters`);
  }
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new RangeError(
      `Imported ${label} must contain between ${minimum} and ${maximum} characters`,
    );
  }
  return normalized;
}

function requireNullableText(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): string | null {
  return value === null ? null : requireText(value, minimum, maximum, label);
}

function requireInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new RangeError(
      `Imported ${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return Number(value);
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Imported timestamp must be an ISO timestamp");
  }
  return new Date(Date.parse(value)).toISOString();
}

function requireNullableTimestamp(value: unknown): string | null {
  return value === null ? null : requireTimestamp(value);
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (!(values as readonly unknown[]).includes(value)) {
    throw new TypeError(`Imported ${label} is unsupported`);
  }
  return value as T[number];
}

function parseBoundedJson(
  value: unknown,
  maximum: number,
  label: string,
): unknown {
  return JSON.parse(serializeBoundedJson(value, maximum, label)) as unknown;
}

function serializeBoundedJson(
  value: unknown,
  maximum: number,
  label: string,
): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      `Imported ${label} must be JSON-safe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    serialized === undefined ||
    serialized.length < 2 ||
    Buffer.byteLength(serialized, "utf8") > maximum
  ) {
    throw new RangeError(`Imported ${label} exceeds the ${maximum}-byte limit`);
  }
  return serialized;
}

function rejectDuplicate<T>(seen: Set<T>, value: T, label: string): void {
  if (seen.has(value))
    throw new TypeError(`Guild import contains duplicate ${label}`);
  seen.add(value);
}

function text(value: unknown): string {
  return String(value);
}

function nullableText(value: unknown): string | null {
  return value === null ? null : String(value);
}

function number(value: unknown): number {
  return Number(value);
}

function bool(value: unknown): boolean {
  return Boolean(value);
}
