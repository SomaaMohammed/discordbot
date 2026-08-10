import type Database from "better-sqlite3";
import {
  GUILD_SETTINGS_VERSION,
  isDiscordSnowflake,
  parseGuildSettingsJson,
} from "../guild-settings.js";
import { isActiveMetricKey } from "./metric-keys.js";

export const CURRENT_SCHEMA_VERSION = 7 as const;
export const LEGACY_V6_SCHEMA_VERSION = 6 as const;
export const LEGACY_V5_SCHEMA_VERSION = 5 as const;
export const LEGACY_V4_SCHEMA_VERSION = 4 as const;
export const LEGACY_V3_SCHEMA_VERSION = 3 as const;
export const LEGACY_V2_SCHEMA_VERSION = 2 as const;

const V4_PANEL_PRESETS = [
  "help",
  "server-info",
  "resources",
  "tickets",
] as const;
const V4_TICKET_STATES = [
  "creating",
  "open",
  "closing",
  "closed",
  "failed",
] as const;
const V4_TICKET_EVENT_TYPES = [
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
] as const;

export type DatabaseSchemaKind =
  | "empty"
  | "legacy-v1"
  | "legacy-v2"
  | "legacy-v3"
  | "legacy-v4"
  | "legacy-v5"
  | "legacy-v6"
  | "current-v7"
  | "unknown";

export const SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER NOT NULL PRIMARY KEY CHECK (version > 0),
  applied_at TEXT NOT NULL
)
`;

export const GUILDS_TABLE_SQL = `
CREATE TABLE guilds (
  guild_id TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(guild_id) BETWEEN 17 AND 20
      AND guild_id NOT GLOB '*[^0-9]*'
    ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  name TEXT,
  joined_at TEXT,
  left_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`;

export const GUILD_SETTINGS_TABLE_SQL = `
CREATE TABLE guild_settings (
  guild_id TEXT NOT NULL PRIMARY KEY,
  settings_version INTEGER NOT NULL CHECK (settings_version = 2),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const METRICS_TABLE_SQL = `
CREATE TABLE metrics (
  guild_id TEXT NOT NULL,
  metric_key TEXT NOT NULL CHECK (length(metric_key) BETWEEN 1 AND 200),
  metric_value INTEGER NOT NULL
    CHECK (metric_value BETWEEN 0 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, metric_key),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const GUILDS_ENABLED_LEFT_AT_INDEX_SQL = `
CREATE INDEX idx_guilds_enabled_left_at
ON guilds (enabled, left_at)
`;

export const V3_TABLE_NAMES = [
  "schema_migrations",
  "guilds",
  "guild_settings",
  "metrics",
] as const;

export const V3_EXPLICIT_INDEX_NAMES = ["idx_guilds_enabled_left_at"] as const;

const V3_TABLE_SQL: Record<(typeof V3_TABLE_NAMES)[number], string> = {
  schema_migrations: SCHEMA_MIGRATIONS_TABLE_SQL,
  guilds: GUILDS_TABLE_SQL,
  guild_settings: GUILD_SETTINGS_TABLE_SQL,
  metrics: METRICS_TABLE_SQL,
};

const V3_INDEX_SQL: Record<(typeof V3_EXPLICIT_INDEX_NAMES)[number], string> = {
  idx_guilds_enabled_left_at: GUILDS_ENABLED_LEFT_AT_INDEX_SQL,
};

export const TICKET_CONFIGURATIONS_TABLE_SQL = `
CREATE TABLE ticket_configurations (
  guild_id TEXT NOT NULL PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  category_id TEXT NOT NULL
    CHECK (
      length(category_id) BETWEEN 17 AND 20
      AND category_id NOT GLOB '*[^0-9]*'
    ),
  log_channel_id TEXT NOT NULL
    CHECK (
      length(log_channel_id) BETWEEN 17 AND 20
      AND log_channel_id NOT GLOB '*[^0-9]*'
    ),
  support_role_id TEXT NOT NULL
    CHECK (
      length(support_role_id) BETWEEN 17 AND 20
      AND support_role_id NOT GLOB '*[^0-9]*'
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const POSTED_PANELS_TABLE_SQL = `
CREATE TABLE posted_panels (
  guild_id TEXT NOT NULL,
  panel_id TEXT NOT NULL
    CHECK (
      length(panel_id) BETWEEN 8 AND 24
      AND panel_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  preset TEXT NOT NULL
    CHECK (preset IN ('help', 'server-info', 'resources', 'tickets')),
  channel_id TEXT NOT NULL
    CHECK (
      length(channel_id) BETWEEN 17 AND 20
      AND channel_id NOT GLOB '*[^0-9]*'
    ),
  message_id TEXT NOT NULL
    CHECK (
      length(message_id) BETWEEN 17 AND 20
      AND message_id NOT GLOB '*[^0-9]*'
    ),
  configuration_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(CAST(configuration_json AS BLOB)) BETWEEN 2 AND 16000
      AND json_valid(configuration_json)
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, panel_id),
  UNIQUE (guild_id, preset, channel_id),
  UNIQUE (guild_id, channel_id, message_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const TICKETS_TABLE_SQL = `
CREATE TABLE tickets (
  guild_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL
    CHECK (
      length(ticket_id) BETWEEN 8 AND 24
      AND ticket_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ticket_number INTEGER NOT NULL CHECK (ticket_number BETWEEN 1 AND 2147483647),
  opener_id TEXT NOT NULL
    CHECK (
      length(opener_id) BETWEEN 17 AND 20
      AND opener_id NOT GLOB '*[^0-9]*'
    ),
  channel_id TEXT
    CHECK (
      channel_id IS NULL OR (
        length(channel_id) BETWEEN 17 AND 20
        AND channel_id NOT GLOB '*[^0-9]*'
      )
    ),
  control_message_id TEXT
    CHECK (
      control_message_id IS NULL OR (
        length(control_message_id) BETWEEN 17 AND 20
        AND control_message_id NOT GLOB '*[^0-9]*'
      )
    ),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  state TEXT NOT NULL
    CHECK (state IN ('creating', 'open', 'closing', 'closed', 'failed')),
  claimed_by TEXT
    CHECK (
      claimed_by IS NULL OR (
        length(claimed_by) BETWEEN 17 AND 20
        AND claimed_by NOT GLOB '*[^0-9]*'
      )
    ),
  claimed_at TEXT,
  closed_by TEXT
    CHECK (
      closed_by IS NULL OR (
        length(closed_by) BETWEEN 17 AND 20
        AND closed_by NOT GLOB '*[^0-9]*'
      )
    ),
  close_reason TEXT CHECK (close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 500),
  close_log_message_id TEXT
    CHECK (
      close_log_message_id IS NULL OR (
        length(close_log_message_id) BETWEEN 17 AND 20
        AND close_log_message_id NOT GLOB '*[^0-9]*'
      )
    ),
  close_logged_at TEXT,
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closing_at TEXT,
  closed_at TEXT,
  PRIMARY KEY (guild_id, ticket_id),
  UNIQUE (guild_id, ticket_number),
  CHECK ((claimed_by IS NULL) = (claimed_at IS NULL)),
  CHECK (control_message_id IS NULL OR channel_id IS NOT NULL),
  CHECK (state IN ('creating', 'failed') OR channel_id IS NOT NULL),
  CHECK ((state = 'failed') = (failure_reason IS NOT NULL)),
  CHECK ((state IN ('closing', 'closed')) = (closing_at IS NOT NULL)),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((state IN ('closing', 'closed')) = (closed_by IS NOT NULL)),
  CHECK ((state IN ('closing', 'closed')) = (close_reason IS NOT NULL)),
  CHECK ((close_log_message_id IS NULL) = (close_logged_at IS NULL)),
  CHECK (close_logged_at IS NULL OR state IN ('closing', 'closed')),
  CHECK (state != 'closed' OR close_logged_at IS NOT NULL),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const TICKET_EVENTS_TABLE_SQL = `
CREATE TABLE ticket_events (
  guild_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  event_id TEXT NOT NULL
    CHECK (
      length(event_id) BETWEEN 8 AND 24
      AND event_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  event_number INTEGER NOT NULL CHECK (event_number BETWEEN 1 AND 2147483647),
  event_type TEXT NOT NULL
    CHECK (
      event_type IN (
        'creation_reserved', 'creation_activated', 'creation_failed',
        'claimed', 'released', 'close_started', 'close_logged', 'close_failed', 'closed',
        'rebound', 'recovery_noted'
      )
    ),
  actor_id TEXT
    CHECK (
      actor_id IS NULL OR (
        length(actor_id) BETWEEN 17 AND 20
        AND actor_id NOT GLOB '*[^0-9]*'
      )
    ),
  details_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(CAST(details_json AS BLOB)) BETWEEN 2 AND 4000
      AND json_valid(details_json)
    ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, ticket_id, event_id),
  UNIQUE (guild_id, ticket_id, event_number),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, ticket_id)
    REFERENCES tickets(guild_id, ticket_id) ON DELETE CASCADE
)
`;

export const POSTED_PANELS_GUILD_PRESET_INDEX_SQL = `
CREATE INDEX idx_posted_panels_guild_preset
ON posted_panels (guild_id, preset, channel_id)
`;

export const TICKETS_GUILD_OPENER_ACTIVE_INDEX_SQL = `
CREATE UNIQUE INDEX idx_tickets_guild_opener_active
ON tickets (guild_id, opener_id)
WHERE state IN ('creating', 'open', 'closing')
`;

export const TICKETS_GUILD_CHANNEL_INDEX_SQL = `
CREATE UNIQUE INDEX idx_tickets_guild_channel
ON tickets (guild_id, channel_id)
WHERE channel_id IS NOT NULL
`;

export const TICKETS_GUILD_STATE_INDEX_SQL = `
CREATE INDEX idx_tickets_guild_state
ON tickets (guild_id, state, ticket_number DESC)
`;

export const TICKETS_GUILD_CLOSE_LOG_MESSAGE_INDEX_SQL = `
CREATE UNIQUE INDEX idx_tickets_guild_close_log_message
ON tickets (guild_id, close_log_message_id)
WHERE close_log_message_id IS NOT NULL
`;

export const TICKET_EVENTS_TICKET_INDEX_SQL = `
CREATE INDEX idx_ticket_events_ticket
ON ticket_events (guild_id, ticket_id, event_number)
`;

export const V4_TABLE_NAMES = [
  ...V3_TABLE_NAMES,
  "ticket_configurations",
  "posted_panels",
  "tickets",
  "ticket_events",
] as const;

export const V4_EXPLICIT_INDEX_NAMES = [
  ...V3_EXPLICIT_INDEX_NAMES,
  "idx_posted_panels_guild_preset",
  "idx_tickets_guild_opener_active",
  "idx_tickets_guild_channel",
  "idx_tickets_guild_state",
  "idx_tickets_guild_close_log_message",
  "idx_ticket_events_ticket",
] as const;

const V4_TABLE_SQL: Record<(typeof V4_TABLE_NAMES)[number], string> = {
  ...V3_TABLE_SQL,
  ticket_configurations: TICKET_CONFIGURATIONS_TABLE_SQL,
  posted_panels: POSTED_PANELS_TABLE_SQL,
  tickets: TICKETS_TABLE_SQL,
  ticket_events: TICKET_EVENTS_TABLE_SQL,
};

const V4_INDEX_SQL: Record<(typeof V4_EXPLICIT_INDEX_NAMES)[number], string> = {
  ...V3_INDEX_SQL,
  idx_posted_panels_guild_preset: POSTED_PANELS_GUILD_PRESET_INDEX_SQL,
  idx_tickets_guild_opener_active: TICKETS_GUILD_OPENER_ACTIVE_INDEX_SQL,
  idx_tickets_guild_channel: TICKETS_GUILD_CHANNEL_INDEX_SQL,
  idx_tickets_guild_state: TICKETS_GUILD_STATE_INDEX_SQL,
  idx_tickets_guild_close_log_message:
    TICKETS_GUILD_CLOSE_LOG_MESSAGE_INDEX_SQL,
  idx_ticket_events_ticket: TICKET_EVENTS_TICKET_INDEX_SQL,
};

export const DELEGATED_CAPABILITIES = [
  "panels.manage",
  "tickets.configure",
  "tickets.manage",
  "suggestions.configure",
  "suggestions.review",
  "applications.configure",
  "applications.review",
] as const;

export const FORM_FIELD_TYPES = ["short", "paragraph"] as const;
export const SUGGESTION_STATES = [
  "open",
  "under-review",
  "accepted",
  "declined",
  "implemented",
  "withdrawn",
] as const;
export const DELIVERY_STATES = [
  "reserved",
  "posted",
  "failed",
  "missing",
] as const;
export const SUGGESTION_EVENT_TYPES = [
  "submission_reserved",
  "submission_posted",
  "submission_failed",
  "vote_changed",
  "state_changed",
  "withdrawn",
  "rebound",
  "recovery_noted",
] as const;
export const APPLICATION_STATES = [
  "submitted",
  "under-review",
  "accepted",
  "rejected",
  "withdrawn",
] as const;
export const APPLICATION_EVENT_TYPES = [
  "submission_reserved",
  "submission_posted",
  "submission_failed",
  "claimed",
  "decision_recorded",
  "withdrawn",
  "rebound",
  "recovery_noted",
] as const;

export const DELEGATED_CAPABILITY_GRANTS_TABLE_SQL = `
CREATE TABLE delegated_capability_grants (
  guild_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type = 'role'),
  principal_id TEXT NOT NULL
    CHECK (
      length(principal_id) BETWEEN 17 AND 20
      AND principal_id NOT GLOB '*[^0-9]*'
    ),
  capability TEXT NOT NULL
    CHECK (
      capability IN (
        'panels.manage', 'tickets.configure', 'tickets.manage',
        'suggestions.configure', 'suggestions.review',
        'applications.configure', 'applications.review'
      )
    ),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  granted_by TEXT NOT NULL
    CHECK (
      length(granted_by) BETWEEN 17 AND 20
      AND granted_by NOT GLOB '*[^0-9]*'
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, principal_type, principal_id, capability),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const TICKET_DEPARTMENTS_TABLE_SQL = `
CREATE TABLE ticket_departments (
  guild_id TEXT NOT NULL,
  department_id TEXT NOT NULL
    CHECK (
      length(department_id) BETWEEN 8 AND 24
      AND department_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  slug TEXT NOT NULL
    CHECK (
      length(slug) BETWEEN 1 AND 32
      AND slug NOT GLOB '*[^a-z0-9-]*'
      AND substr(slug, 1, 1) NOT GLOB '[^a-z0-9]'
      AND substr(slug, -1, 1) NOT GLOB '[^a-z0-9]'
      AND instr(slug, '--') = 0
    ),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  emoji TEXT CHECK (emoji IS NULL OR length(emoji) BETWEEN 1 AND 16),
  category_id TEXT
    CHECK (
      category_id IS NULL OR (
        length(category_id) BETWEEN 17 AND 20
        AND category_id NOT GLOB '*[^0-9]*'
      )
    ),
  log_channel_id TEXT
    CHECK (
      log_channel_id IS NULL OR (
        length(log_channel_id) BETWEEN 17 AND 20
        AND log_channel_id NOT GLOB '*[^0-9]*'
      )
    ),
  support_role_id TEXT
    CHECK (
      support_role_id IS NULL OR (
        length(support_role_id) BETWEEN 17 AND 20
        AND support_role_id NOT GLOB '*[^0-9]*'
      )
    ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 9),
  definition_version INTEGER NOT NULL DEFAULT 1
    CHECK (definition_version BETWEEN 1 AND 2147483647),
  bindings_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, department_id),
  UNIQUE (guild_id, slug),
  CHECK (
    enabled = 0 OR (
      category_id IS NOT NULL
      AND log_channel_id IS NOT NULL
      AND support_role_id IS NOT NULL
    )
  ),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const TICKET_DEPARTMENT_FIELDS_TABLE_SQL = `
CREATE TABLE ticket_department_fields (
  guild_id TEXT NOT NULL,
  department_id TEXT NOT NULL,
  field_id TEXT NOT NULL
    CHECK (
      length(field_id) BETWEEN 8 AND 24
      AND field_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 45),
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 100),
  placeholder TEXT CHECK (placeholder IS NULL OR length(placeholder) BETWEEN 1 AND 100),
  field_type TEXT NOT NULL CHECK (field_type IN ('short', 'paragraph')),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  min_length INTEGER NOT NULL DEFAULT 0 CHECK (min_length BETWEEN 0 AND 4000),
  max_length INTEGER NOT NULL CHECK (max_length BETWEEN 1 AND 4000),
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 4),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, department_id, field_id),
  UNIQUE (guild_id, department_id, sort_order),
  CHECK (min_length <= max_length),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, department_id)
    REFERENCES ticket_departments(guild_id, department_id) ON DELETE CASCADE
)
`;

export const V5_POSTED_PANELS_TABLE_SQL = `
CREATE TABLE posted_panels (
  guild_id TEXT NOT NULL,
  panel_id TEXT NOT NULL
    CHECK (
      length(panel_id) BETWEEN 8 AND 24
      AND panel_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  preset TEXT NOT NULL
    CHECK (preset IN ('help', 'server-info', 'resources', 'tickets', 'suggestions', 'applications')),
  channel_id TEXT NOT NULL
    CHECK (
      length(channel_id) BETWEEN 17 AND 20
      AND channel_id NOT GLOB '*[^0-9]*'
    ),
  message_id TEXT NOT NULL
    CHECK (
      length(message_id) BETWEEN 17 AND 20
      AND message_id NOT GLOB '*[^0-9]*'
    ),
  configuration_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(CAST(configuration_json AS BLOB)) BETWEEN 2 AND 16000
      AND json_valid(configuration_json)
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, panel_id),
  UNIQUE (guild_id, preset, channel_id),
  UNIQUE (guild_id, channel_id, message_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const V5_TICKETS_TABLE_SQL = `
CREATE TABLE tickets (
  guild_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL
    CHECK (
      length(ticket_id) BETWEEN 8 AND 24
      AND ticket_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  ticket_number INTEGER NOT NULL CHECK (ticket_number BETWEEN 1 AND 2147483647),
  department_id TEXT NOT NULL
    CHECK (
      length(department_id) BETWEEN 8 AND 24
      AND department_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  opener_id TEXT NOT NULL
    CHECK (
      length(opener_id) BETWEEN 17 AND 20
      AND opener_id NOT GLOB '*[^0-9]*'
    ),
  channel_id TEXT
    CHECK (
      channel_id IS NULL OR (
        length(channel_id) BETWEEN 17 AND 20
        AND channel_id NOT GLOB '*[^0-9]*'
      )
    ),
  control_message_id TEXT
    CHECK (
      control_message_id IS NULL OR (
        length(control_message_id) BETWEEN 17 AND 20
        AND control_message_id NOT GLOB '*[^0-9]*'
      )
    ),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  state TEXT NOT NULL
    CHECK (state IN ('creating', 'open', 'closing', 'closed', 'failed')),
  claimed_by TEXT
    CHECK (
      claimed_by IS NULL OR (
        length(claimed_by) BETWEEN 17 AND 20
        AND claimed_by NOT GLOB '*[^0-9]*'
      )
    ),
  claimed_at TEXT,
  closed_by TEXT
    CHECK (
      closed_by IS NULL OR (
        length(closed_by) BETWEEN 17 AND 20
        AND closed_by NOT GLOB '*[^0-9]*'
      )
    ),
  close_reason TEXT CHECK (close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 500),
  close_log_message_id TEXT
    CHECK (
      close_log_message_id IS NULL OR (
        length(close_log_message_id) BETWEEN 17 AND 20
        AND close_log_message_id NOT GLOB '*[^0-9]*'
      )
    ),
  close_logged_at TEXT,
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closing_at TEXT,
  closed_at TEXT,
  PRIMARY KEY (guild_id, ticket_id),
  UNIQUE (guild_id, ticket_number),
  CHECK ((claimed_by IS NULL) = (claimed_at IS NULL)),
  CHECK (control_message_id IS NULL OR channel_id IS NOT NULL),
  CHECK (state IN ('creating', 'failed') OR channel_id IS NOT NULL),
  CHECK ((state = 'failed') = (failure_reason IS NOT NULL)),
  CHECK ((state IN ('closing', 'closed')) = (closing_at IS NOT NULL)),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((state IN ('closing', 'closed')) = (closed_by IS NOT NULL)),
  CHECK ((state IN ('closing', 'closed')) = (close_reason IS NOT NULL)),
  CHECK ((close_log_message_id IS NULL) = (close_logged_at IS NULL)),
  CHECK (close_logged_at IS NULL OR state IN ('closing', 'closed')),
  CHECK (state != 'closed' OR close_logged_at IS NOT NULL),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, department_id)
    REFERENCES ticket_departments(guild_id, department_id)
)
`;

export const TICKET_FORM_RESPONSES_TABLE_SQL = `
CREATE TABLE ticket_form_responses (
  guild_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  response_id TEXT NOT NULL
    CHECK (
      length(response_id) BETWEEN 8 AND 24
      AND response_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  field_id TEXT NOT NULL
    CHECK (
      length(field_id) BETWEEN 8 AND 24
      AND field_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  field_label TEXT NOT NULL CHECK (length(field_label) BETWEEN 1 AND 45),
  field_type TEXT NOT NULL CHECK (field_type IN ('short', 'paragraph')),
  response_text TEXT NOT NULL CHECK (length(response_text) BETWEEN 0 AND 4000),
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 4),
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, ticket_id, response_id),
  UNIQUE (guild_id, ticket_id, field_id),
  UNIQUE (guild_id, ticket_id, sort_order),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, ticket_id)
    REFERENCES tickets(guild_id, ticket_id) ON DELETE CASCADE
)
`;

export const SUGGESTION_CONFIGURATIONS_TABLE_SQL = `
CREATE TABLE suggestion_configurations (
  guild_id TEXT NOT NULL PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  suggestion_channel_id TEXT NOT NULL
    CHECK (
      length(suggestion_channel_id) BETWEEN 17 AND 20
      AND suggestion_channel_id NOT GLOB '*[^0-9]*'
    ),
  review_channel_id TEXT
    CHECK (
      review_channel_id IS NULL OR (
        length(review_channel_id) BETWEEN 17 AND 20
        AND review_channel_id NOT GLOB '*[^0-9]*'
      )
    ),
  reviewer_role_id TEXT NOT NULL
    CHECK (
      length(reviewer_role_id) BETWEEN 17 AND 20
      AND reviewer_role_id NOT GLOB '*[^0-9]*'
    ),
  create_threads INTEGER NOT NULL DEFAULT 0 CHECK (create_threads IN (0, 1)),
  cooldown_limit INTEGER NOT NULL DEFAULT 3 CHECK (cooldown_limit BETWEEN 1 AND 10),
  cooldown_window_seconds INTEGER NOT NULL DEFAULT 600
    CHECK (cooldown_window_seconds BETWEEN 60 AND 86400),
  allow_self_votes INTEGER NOT NULL DEFAULT 0 CHECK (allow_self_votes IN (0, 1)),
  bindings_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const SUGGESTIONS_TABLE_SQL = `
CREATE TABLE suggestions (
  guild_id TEXT NOT NULL,
  suggestion_id TEXT NOT NULL
    CHECK (
      length(suggestion_id) BETWEEN 8 AND 24
      AND suggestion_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  suggestion_number INTEGER NOT NULL CHECK (suggestion_number BETWEEN 1 AND 2147483647),
  author_id TEXT NOT NULL
    CHECK (
      length(author_id) BETWEEN 17 AND 20
      AND author_id NOT GLOB '*[^0-9]*'
    ),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  details TEXT NOT NULL CHECK (length(details) BETWEEN 1 AND 4000),
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'under-review', 'accepted', 'declined', 'implemented', 'withdrawn')),
  delivery_state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (delivery_state IN ('reserved', 'posted', 'failed', 'missing')),
  channel_id TEXT
    CHECK (
      channel_id IS NULL OR (
        length(channel_id) BETWEEN 17 AND 20
        AND channel_id NOT GLOB '*[^0-9]*'
      )
    ),
  message_id TEXT
    CHECK (
      message_id IS NULL OR (
        length(message_id) BETWEEN 17 AND 20
        AND message_id NOT GLOB '*[^0-9]*'
      )
    ),
  thread_id TEXT
    CHECK (
      thread_id IS NULL OR (
        length(thread_id) BETWEEN 17 AND 20
        AND thread_id NOT GLOB '*[^0-9]*'
      )
    ),
  reviewer_id TEXT
    CHECK (
      reviewer_id IS NULL OR (
        length(reviewer_id) BETWEEN 17 AND 20
        AND reviewer_id NOT GLOB '*[^0-9]*'
      )
    ),
  review_reason TEXT CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 1000),
  reviewed_at TEXT,
  withdrawn_at TEXT,
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, suggestion_id),
  UNIQUE (guild_id, suggestion_number),
  CHECK ((message_id IS NULL) = (channel_id IS NULL)),
  CHECK (thread_id IS NULL OR message_id IS NOT NULL),
  CHECK ((delivery_state IN ('posted', 'missing')) = (message_id IS NOT NULL)),
  CHECK ((delivery_state = 'failed') = (failure_reason IS NOT NULL)),
  CHECK (
    (state IN ('under-review', 'accepted', 'declined', 'implemented')) =
    (reviewer_id IS NOT NULL AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const SUGGESTION_VOTES_TABLE_SQL = `
CREATE TABLE suggestion_votes (
  guild_id TEXT NOT NULL,
  suggestion_id TEXT NOT NULL,
  voter_id TEXT NOT NULL
    CHECK (
      length(voter_id) BETWEEN 17 AND 20
      AND voter_id NOT GLOB '*[^0-9]*'
    ),
  vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, suggestion_id, voter_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, suggestion_id)
    REFERENCES suggestions(guild_id, suggestion_id) ON DELETE CASCADE
)
`;

export const SUGGESTION_EVENTS_TABLE_SQL = `
CREATE TABLE suggestion_events (
  guild_id TEXT NOT NULL,
  suggestion_id TEXT NOT NULL,
  event_id TEXT NOT NULL
    CHECK (
      length(event_id) BETWEEN 8 AND 24
      AND event_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  event_number INTEGER NOT NULL CHECK (event_number BETWEEN 1 AND 2147483647),
  event_type TEXT NOT NULL
    CHECK (
      event_type IN (
        'submission_reserved', 'submission_posted', 'submission_failed',
        'vote_changed', 'state_changed', 'withdrawn', 'rebound', 'recovery_noted'
      )
    ),
  actor_id TEXT
    CHECK (
      actor_id IS NULL OR (
        length(actor_id) BETWEEN 17 AND 20
        AND actor_id NOT GLOB '*[^0-9]*'
      )
    ),
  details_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(CAST(details_json AS BLOB)) BETWEEN 2 AND 4000
      AND json_valid(details_json)
    ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, suggestion_id, event_id),
  UNIQUE (guild_id, suggestion_id, event_number),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, suggestion_id)
    REFERENCES suggestions(guild_id, suggestion_id) ON DELETE CASCADE
)
`;

export const APPLICATION_FORMS_TABLE_SQL = `
CREATE TABLE application_forms (
  guild_id TEXT NOT NULL,
  form_id TEXT NOT NULL
    CHECK (
      length(form_id) BETWEEN 8 AND 24
      AND form_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  slug TEXT NOT NULL
    CHECK (
      length(slug) BETWEEN 1 AND 32
      AND slug NOT GLOB '*[^a-z0-9-]*'
      AND substr(slug, 1, 1) NOT GLOB '[^a-z0-9]'
      AND substr(slug, -1, 1) NOT GLOB '[^a-z0-9]'
      AND instr(slug, '--') = 0
    ),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1000),
  reviewer_role_id TEXT NOT NULL
    CHECK (
      length(reviewer_role_id) BETWEEN 17 AND 20
      AND reviewer_role_id NOT GLOB '*[^0-9]*'
    ),
  review_channel_id TEXT NOT NULL
    CHECK (
      length(review_channel_id) BETWEEN 17 AND 20
      AND review_channel_id NOT GLOB '*[^0-9]*'
    ),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 24),
  definition_version INTEGER NOT NULL DEFAULT 1
    CHECK (definition_version BETWEEN 1 AND 2147483647),
  bindings_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, form_id),
  UNIQUE (guild_id, slug),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const APPLICATION_FORM_FIELDS_TABLE_SQL = `
CREATE TABLE application_form_fields (
  guild_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  field_id TEXT NOT NULL
    CHECK (
      length(field_id) BETWEEN 8 AND 24
      AND field_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 45),
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 100),
  placeholder TEXT CHECK (placeholder IS NULL OR length(placeholder) BETWEEN 1 AND 100),
  field_type TEXT NOT NULL CHECK (field_type IN ('short', 'paragraph')),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  min_length INTEGER NOT NULL DEFAULT 0 CHECK (min_length BETWEEN 0 AND 4000),
  max_length INTEGER NOT NULL CHECK (max_length BETWEEN 1 AND 4000),
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 4),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, form_id, field_id),
  UNIQUE (guild_id, form_id, sort_order),
  CHECK (min_length <= max_length),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, form_id)
    REFERENCES application_forms(guild_id, form_id) ON DELETE CASCADE
)
`;

export const APPLICATIONS_TABLE_SQL = `
CREATE TABLE applications (
  guild_id TEXT NOT NULL,
  application_id TEXT NOT NULL
    CHECK (
      length(application_id) BETWEEN 8 AND 24
      AND application_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  application_number INTEGER NOT NULL CHECK (application_number BETWEEN 1 AND 2147483647),
  form_id TEXT NOT NULL
    CHECK (
      length(form_id) BETWEEN 8 AND 24
      AND form_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  applicant_id TEXT NOT NULL
    CHECK (
      length(applicant_id) BETWEEN 17 AND 20
      AND applicant_id NOT GLOB '*[^0-9]*'
    ),
  state TEXT NOT NULL DEFAULT 'submitted'
    CHECK (state IN ('submitted', 'under-review', 'accepted', 'rejected', 'withdrawn')),
  delivery_state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (delivery_state IN ('reserved', 'posted', 'failed', 'missing')),
  review_channel_id TEXT
    CHECK (
      review_channel_id IS NULL OR (
        length(review_channel_id) BETWEEN 17 AND 20
        AND review_channel_id NOT GLOB '*[^0-9]*'
      )
    ),
  review_message_id TEXT
    CHECK (
      review_message_id IS NULL OR (
        length(review_message_id) BETWEEN 17 AND 20
        AND review_message_id NOT GLOB '*[^0-9]*'
      )
    ),
  claimed_by TEXT
    CHECK (
      claimed_by IS NULL OR (
        length(claimed_by) BETWEEN 17 AND 20
        AND claimed_by NOT GLOB '*[^0-9]*'
      )
    ),
  claimed_at TEXT,
  decision_by TEXT
    CHECK (
      decision_by IS NULL OR (
        length(decision_by) BETWEEN 17 AND 20
        AND decision_by NOT GLOB '*[^0-9]*'
      )
    ),
  decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 1000),
  decided_at TEXT,
  withdrawn_at TEXT,
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, application_id),
  UNIQUE (guild_id, application_number),
  CHECK ((review_message_id IS NULL) = (review_channel_id IS NULL)),
  CHECK ((delivery_state IN ('posted', 'missing')) = (review_message_id IS NOT NULL)),
  CHECK ((delivery_state = 'failed') = (failure_reason IS NOT NULL)),
  CHECK ((claimed_by IS NULL) = (claimed_at IS NULL)),
  CHECK (state != 'under-review' OR claimed_by IS NOT NULL),
  CHECK (
    (state IN ('accepted', 'rejected')) =
    (decision_by IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, form_id)
    REFERENCES application_forms(guild_id, form_id)
)
`;

export const APPLICATION_RESPONSES_TABLE_SQL = `
CREATE TABLE application_responses (
  guild_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  response_id TEXT NOT NULL
    CHECK (
      length(response_id) BETWEEN 8 AND 24
      AND response_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  field_id TEXT NOT NULL
    CHECK (
      length(field_id) BETWEEN 8 AND 24
      AND field_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  field_label TEXT NOT NULL CHECK (length(field_label) BETWEEN 1 AND 45),
  field_type TEXT NOT NULL CHECK (field_type IN ('short', 'paragraph')),
  response_text TEXT NOT NULL CHECK (length(response_text) BETWEEN 0 AND 4000),
  sort_order INTEGER NOT NULL CHECK (sort_order BETWEEN 0 AND 4),
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, application_id, response_id),
  UNIQUE (guild_id, application_id, field_id),
  UNIQUE (guild_id, application_id, sort_order),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, application_id)
    REFERENCES applications(guild_id, application_id) ON DELETE CASCADE
)
`;

export const APPLICATION_EVENTS_TABLE_SQL = `
CREATE TABLE application_events (
  guild_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  event_id TEXT NOT NULL
    CHECK (
      length(event_id) BETWEEN 8 AND 24
      AND event_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  event_number INTEGER NOT NULL CHECK (event_number BETWEEN 1 AND 2147483647),
  event_type TEXT NOT NULL
    CHECK (
      event_type IN (
        'submission_reserved', 'submission_posted', 'submission_failed',
        'claimed', 'decision_recorded', 'withdrawn', 'rebound', 'recovery_noted'
      )
    ),
  actor_id TEXT
    CHECK (
      actor_id IS NULL OR (
        length(actor_id) BETWEEN 17 AND 20
        AND actor_id NOT GLOB '*[^0-9]*'
      )
    ),
  details_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(CAST(details_json AS BLOB)) BETWEEN 2 AND 4000
      AND json_valid(details_json)
    ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, application_id, event_id),
  UNIQUE (guild_id, application_id, event_number),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, application_id)
    REFERENCES applications(guild_id, application_id) ON DELETE CASCADE
)
`;

export const RESTRICTED_PING_ROLES_TABLE_SQL = `
CREATE TABLE restricted_ping_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL
    CHECK (
      length(role_id) BETWEEN 17 AND 20
      AND role_id NOT GLOB '*[^0-9]*'
    ),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  user_cooldown_seconds INTEGER NOT NULL DEFAULT 60
    CHECK (user_cooldown_seconds BETWEEN 1 AND 86400),
  role_cooldown_seconds INTEGER NOT NULL DEFAULT 30
    CHECK (role_cooldown_seconds BETWEEN 0 AND 86400),
  allow_threads INTEGER NOT NULL DEFAULT 0 CHECK (allow_threads IN (0, 1)),
  bindings_verified_at TEXT,
  last_role_success_at TEXT,
  success_count INTEGER NOT NULL DEFAULT 0
    CHECK (success_count BETWEEN 0 AND 9007199254740991),
  reservation_id TEXT
    CHECK (
      reservation_id IS NULL OR (
        length(reservation_id) BETWEEN 8 AND 24
        AND reservation_id NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  reservation_user_id TEXT
    CHECK (
      reservation_user_id IS NULL OR (
        length(reservation_user_id) BETWEEN 17 AND 20
        AND reservation_user_id NOT GLOB '*[^0-9]*'
      )
    ),
  reservation_channel_id TEXT
    CHECK (
      reservation_channel_id IS NULL OR (
        length(reservation_channel_id) BETWEEN 17 AND 20
        AND reservation_channel_id NOT GLOB '*[^0-9]*'
      )
    ),
  reservation_source TEXT
    CHECK (
      reservation_source IS NULL OR
      length(reservation_source) BETWEEN 1 AND 100
    ),
  reservation_expires_at TEXT,
  created_by TEXT NOT NULL
    CHECK (
      length(created_by) BETWEEN 17 AND 20
      AND created_by NOT GLOB '*[^0-9]*'
    ),
  updated_by TEXT NOT NULL
    CHECK (
      length(updated_by) BETWEEN 17 AND 20
      AND updated_by NOT GLOB '*[^0-9]*'
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id),
  CHECK (role_id <> guild_id),
  CHECK ((last_role_success_at IS NULL) = (success_count = 0)),
  CHECK (
    (reservation_id IS NULL) = (reservation_user_id IS NULL)
    AND (reservation_id IS NULL) = (reservation_channel_id IS NULL)
    AND (reservation_id IS NULL) = (reservation_source IS NULL)
    AND (reservation_id IS NULL) = (reservation_expires_at IS NULL)
  ),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const RESTRICTED_PING_CHANNELS_TABLE_SQL = `
CREATE TABLE restricted_ping_channels (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL
    CHECK (
      length(role_id) BETWEEN 17 AND 20
      AND role_id NOT GLOB '*[^0-9]*'
    ),
  channel_id TEXT NOT NULL
    CHECK (
      length(channel_id) BETWEEN 17 AND 20
      AND channel_id NOT GLOB '*[^0-9]*'
    ),
  created_by TEXT NOT NULL
    CHECK (
      length(created_by) BETWEEN 17 AND 20
      AND created_by NOT GLOB '*[^0-9]*'
    ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id, channel_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, role_id)
    REFERENCES restricted_ping_roles(guild_id, role_id) ON DELETE CASCADE
)
`;

export const RESTRICTED_PING_USER_COOLDOWNS_TABLE_SQL = `
CREATE TABLE restricted_ping_user_cooldowns (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL
    CHECK (
      length(role_id) BETWEEN 17 AND 20
      AND role_id NOT GLOB '*[^0-9]*'
    ),
  user_id TEXT NOT NULL
    CHECK (
      length(user_id) BETWEEN 17 AND 20
      AND user_id NOT GLOB '*[^0-9]*'
    ),
  last_success_at TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 1
    CHECK (success_count BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id, user_id),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, role_id)
    REFERENCES restricted_ping_roles(guild_id, role_id) ON DELETE CASCADE
)
`;

export const RESTRICTED_PING_EVENTS_TABLE_SQL = `
CREATE TABLE restricted_ping_events (
  guild_id TEXT NOT NULL,
  event_id TEXT NOT NULL
    CHECK (
      length(event_id) BETWEEN 8 AND 24
      AND event_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
  event_number INTEGER NOT NULL CHECK (event_number BETWEEN 1 AND 2147483647),
  event_type TEXT NOT NULL
    CHECK (
      event_type IN (
        'mapping_added', 'mapping_removed', 'configuration_updated',
        'enabled', 'disabled', 'role_deleted', 'channel_deleted',
        'ping_succeeded'
      )
    ),
  actor_id TEXT
    CHECK (
      actor_id IS NULL OR (
        length(actor_id) BETWEEN 17 AND 20
        AND actor_id NOT GLOB '*[^0-9]*'
      )
    ),
  role_id TEXT NOT NULL
    CHECK (
      length(role_id) BETWEEN 17 AND 20
      AND role_id NOT GLOB '*[^0-9]*'
    ),
  channel_id TEXT
    CHECK (
      channel_id IS NULL OR (
        length(channel_id) BETWEEN 17 AND 20
        AND channel_id NOT GLOB '*[^0-9]*'
      )
    ),
  user_id TEXT
    CHECK (
      user_id IS NULL OR (
        length(user_id) BETWEEN 17 AND 20
        AND user_id NOT GLOB '*[^0-9]*'
      )
    ),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  details_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      length(CAST(details_json AS BLOB)) BETWEEN 2 AND 4000
      AND json_valid(details_json)
    ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, event_id),
  UNIQUE (guild_id, event_number),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD = 10_000;

export const MUDAE_WATCH_DELIVERIES_TABLE_SQL = `
CREATE TABLE mudae_watch_deliveries (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL
    CHECK (
      length(message_id) BETWEEN 17 AND 20
      AND message_id NOT GLOB '*[^0-9]*'
    ),
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('reserved', 'delivered', 'failed')),
  reservation_id TEXT
    CHECK (
      reservation_id IS NULL OR (
        length(reservation_id) BETWEEN 8 AND 24
        AND reservation_id NOT GLOB '*[^A-Za-z0-9_-]*'
      )
    ),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, message_id),
  CHECK (
    (
      delivery_state = 'reserved'
      AND reservation_id IS NOT NULL
      AND completed_at IS NULL
    ) OR (
      delivery_state IN ('delivered', 'failed')
      AND reservation_id IS NULL
      AND completed_at IS NOT NULL
    )
  ),
  FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
)
`;

export const CAPABILITY_GRANTS_GUILD_CAPABILITY_INDEX_SQL = `
CREATE INDEX idx_capability_grants_guild_capability
ON delegated_capability_grants (guild_id, active, capability, principal_type, principal_id)
`;
export const CAPABILITY_GRANTS_GUILD_PRINCIPAL_INDEX_SQL = `
CREATE INDEX idx_capability_grants_guild_principal
ON delegated_capability_grants (guild_id, principal_type, principal_id, active)
`;
export const TICKET_DEPARTMENTS_GUILD_ENABLED_INDEX_SQL = `
CREATE INDEX idx_ticket_departments_guild_enabled
ON ticket_departments (guild_id, enabled, sort_order, department_id)
`;
export const TICKET_DEPARTMENT_FIELDS_ORDER_INDEX_SQL = `
CREATE INDEX idx_ticket_department_fields_order
ON ticket_department_fields (guild_id, department_id, sort_order)
`;
export const V5_TICKETS_GUILD_OPENER_DEPARTMENT_ACTIVE_INDEX_SQL = `
CREATE UNIQUE INDEX idx_tickets_guild_opener_department_active
ON tickets (guild_id, department_id, opener_id)
WHERE state IN ('creating', 'open', 'closing')
`;
export const V5_TICKETS_GUILD_OPENER_STATE_INDEX_SQL = `
CREATE INDEX idx_tickets_guild_opener_state
ON tickets (guild_id, opener_id, state, ticket_number DESC)
`;
export const V5_TICKETS_GUILD_DEPARTMENT_STATE_INDEX_SQL = `
CREATE INDEX idx_tickets_guild_department_state
ON tickets (guild_id, department_id, state, ticket_number DESC)
`;
export const SUGGESTIONS_GUILD_STATE_INDEX_SQL = `
CREATE INDEX idx_suggestions_guild_state
ON suggestions (guild_id, state, suggestion_number DESC)
`;
export const SUGGESTIONS_GUILD_AUTHOR_CREATED_INDEX_SQL = `
CREATE INDEX idx_suggestions_guild_author_created
ON suggestions (guild_id, author_id, created_at DESC, suggestion_number DESC)
`;
export const SUGGESTIONS_GUILD_MESSAGE_INDEX_SQL = `
CREATE UNIQUE INDEX idx_suggestions_guild_message
ON suggestions (guild_id, channel_id, message_id)
WHERE message_id IS NOT NULL
`;
export const SUGGESTION_VOTES_TALLY_INDEX_SQL = `
CREATE INDEX idx_suggestion_votes_tally
ON suggestion_votes (guild_id, suggestion_id, vote)
`;
export const SUGGESTION_EVENTS_SUGGESTION_INDEX_SQL = `
CREATE INDEX idx_suggestion_events_suggestion
ON suggestion_events (guild_id, suggestion_id, event_number)
`;
export const APPLICATION_FORMS_GUILD_ENABLED_INDEX_SQL = `
CREATE INDEX idx_application_forms_guild_enabled
ON application_forms (guild_id, enabled, sort_order, form_id)
`;
export const APPLICATION_FORM_FIELDS_ORDER_INDEX_SQL = `
CREATE INDEX idx_application_form_fields_order
ON application_form_fields (guild_id, form_id, sort_order)
`;
export const APPLICATIONS_GUILD_APPLICANT_FORM_ACTIVE_INDEX_SQL = `
CREATE UNIQUE INDEX idx_applications_guild_applicant_form_active
ON applications (guild_id, form_id, applicant_id)
WHERE state IN ('submitted', 'under-review')
`;
export const APPLICATIONS_GUILD_STATE_INDEX_SQL = `
CREATE INDEX idx_applications_guild_state
ON applications (guild_id, state, application_number DESC)
`;
export const APPLICATIONS_GUILD_FORM_STATE_INDEX_SQL = `
CREATE INDEX idx_applications_guild_form_state
ON applications (guild_id, form_id, state, application_number DESC)
`;
export const APPLICATIONS_GUILD_APPLICANT_CREATED_INDEX_SQL = `
CREATE INDEX idx_applications_guild_applicant_created
ON applications (guild_id, applicant_id, created_at DESC, application_number DESC)
`;
export const APPLICATIONS_GUILD_REVIEW_MESSAGE_INDEX_SQL = `
CREATE UNIQUE INDEX idx_applications_guild_review_message
ON applications (guild_id, review_channel_id, review_message_id)
WHERE review_message_id IS NOT NULL
`;
export const APPLICATION_EVENTS_APPLICATION_INDEX_SQL = `
CREATE INDEX idx_application_events_application
ON application_events (guild_id, application_id, event_number)
`;

export const RESTRICTED_PING_ROLES_GUILD_ENABLED_INDEX_SQL = `
CREATE INDEX idx_restricted_ping_roles_guild_enabled
ON restricted_ping_roles (guild_id, enabled, role_id)
`;
export const RESTRICTED_PING_ROLES_RESERVATION_INDEX_SQL = `
CREATE UNIQUE INDEX idx_restricted_ping_roles_reservation
ON restricted_ping_roles (guild_id, reservation_id)
WHERE reservation_id IS NOT NULL
`;
export const RESTRICTED_PING_CHANNELS_GUILD_CHANNEL_INDEX_SQL = `
CREATE INDEX idx_restricted_ping_channels_guild_channel
ON restricted_ping_channels (guild_id, channel_id, role_id)
`;
export const RESTRICTED_PING_EVENTS_ROLE_NUMBER_INDEX_SQL = `
CREATE INDEX idx_restricted_ping_events_role_number
ON restricted_ping_events (guild_id, role_id, event_number DESC)
`;
export const RESTRICTED_PING_EVENTS_SUCCESS_NUMBER_INDEX_SQL = `
CREATE INDEX idx_restricted_ping_events_success_number
ON restricted_ping_events (guild_id, event_type, event_number DESC)
`;

export const MUDAE_WATCH_DELIVERIES_GUILD_STATE_UPDATED_INDEX_SQL = `
CREATE INDEX idx_mudae_watch_deliveries_guild_state_updated
ON mudae_watch_deliveries (
  guild_id, delivery_state, updated_at DESC, message_id
)
`;

export const MUDAE_WATCH_DELIVERIES_RESERVATION_INDEX_SQL = `
CREATE UNIQUE INDEX idx_mudae_watch_deliveries_reservation
ON mudae_watch_deliveries (guild_id, reservation_id)
WHERE reservation_id IS NOT NULL
`;

export const V5_TABLE_NAMES = [
  ...V3_TABLE_NAMES,
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

export const V5_EXPLICIT_INDEX_NAMES = [
  ...V3_EXPLICIT_INDEX_NAMES,
  "idx_capability_grants_guild_capability",
  "idx_capability_grants_guild_principal",
  "idx_ticket_departments_guild_enabled",
  "idx_ticket_department_fields_order",
  "idx_posted_panels_guild_preset",
  "idx_tickets_guild_opener_department_active",
  "idx_tickets_guild_opener_state",
  "idx_tickets_guild_channel",
  "idx_tickets_guild_state",
  "idx_tickets_guild_department_state",
  "idx_tickets_guild_close_log_message",
  "idx_ticket_events_ticket",
  "idx_suggestions_guild_state",
  "idx_suggestions_guild_author_created",
  "idx_suggestions_guild_message",
  "idx_suggestion_votes_tally",
  "idx_suggestion_events_suggestion",
  "idx_application_forms_guild_enabled",
  "idx_application_form_fields_order",
  "idx_applications_guild_applicant_form_active",
  "idx_applications_guild_state",
  "idx_applications_guild_form_state",
  "idx_applications_guild_applicant_created",
  "idx_applications_guild_review_message",
  "idx_application_events_application",
] as const;

const V5_TABLE_SQL: Record<(typeof V5_TABLE_NAMES)[number], string> = {
  ...V3_TABLE_SQL,
  delegated_capability_grants: DELEGATED_CAPABILITY_GRANTS_TABLE_SQL,
  ticket_departments: TICKET_DEPARTMENTS_TABLE_SQL,
  ticket_department_fields: TICKET_DEPARTMENT_FIELDS_TABLE_SQL,
  posted_panels: V5_POSTED_PANELS_TABLE_SQL,
  tickets: V5_TICKETS_TABLE_SQL,
  ticket_form_responses: TICKET_FORM_RESPONSES_TABLE_SQL,
  ticket_events: TICKET_EVENTS_TABLE_SQL,
  suggestion_configurations: SUGGESTION_CONFIGURATIONS_TABLE_SQL,
  suggestions: SUGGESTIONS_TABLE_SQL,
  suggestion_votes: SUGGESTION_VOTES_TABLE_SQL,
  suggestion_events: SUGGESTION_EVENTS_TABLE_SQL,
  application_forms: APPLICATION_FORMS_TABLE_SQL,
  application_form_fields: APPLICATION_FORM_FIELDS_TABLE_SQL,
  applications: APPLICATIONS_TABLE_SQL,
  application_responses: APPLICATION_RESPONSES_TABLE_SQL,
  application_events: APPLICATION_EVENTS_TABLE_SQL,
};

const V5_INDEX_SQL: Record<(typeof V5_EXPLICIT_INDEX_NAMES)[number], string> = {
  ...V3_INDEX_SQL,
  idx_capability_grants_guild_capability:
    CAPABILITY_GRANTS_GUILD_CAPABILITY_INDEX_SQL,
  idx_capability_grants_guild_principal:
    CAPABILITY_GRANTS_GUILD_PRINCIPAL_INDEX_SQL,
  idx_ticket_departments_guild_enabled:
    TICKET_DEPARTMENTS_GUILD_ENABLED_INDEX_SQL,
  idx_ticket_department_fields_order: TICKET_DEPARTMENT_FIELDS_ORDER_INDEX_SQL,
  idx_posted_panels_guild_preset: POSTED_PANELS_GUILD_PRESET_INDEX_SQL,
  idx_tickets_guild_opener_department_active:
    V5_TICKETS_GUILD_OPENER_DEPARTMENT_ACTIVE_INDEX_SQL,
  idx_tickets_guild_opener_state: V5_TICKETS_GUILD_OPENER_STATE_INDEX_SQL,
  idx_tickets_guild_channel: TICKETS_GUILD_CHANNEL_INDEX_SQL,
  idx_tickets_guild_state: TICKETS_GUILD_STATE_INDEX_SQL,
  idx_tickets_guild_department_state:
    V5_TICKETS_GUILD_DEPARTMENT_STATE_INDEX_SQL,
  idx_tickets_guild_close_log_message:
    TICKETS_GUILD_CLOSE_LOG_MESSAGE_INDEX_SQL,
  idx_ticket_events_ticket: TICKET_EVENTS_TICKET_INDEX_SQL,
  idx_suggestions_guild_state: SUGGESTIONS_GUILD_STATE_INDEX_SQL,
  idx_suggestions_guild_author_created:
    SUGGESTIONS_GUILD_AUTHOR_CREATED_INDEX_SQL,
  idx_suggestions_guild_message: SUGGESTIONS_GUILD_MESSAGE_INDEX_SQL,
  idx_suggestion_votes_tally: SUGGESTION_VOTES_TALLY_INDEX_SQL,
  idx_suggestion_events_suggestion: SUGGESTION_EVENTS_SUGGESTION_INDEX_SQL,
  idx_application_forms_guild_enabled:
    APPLICATION_FORMS_GUILD_ENABLED_INDEX_SQL,
  idx_application_form_fields_order: APPLICATION_FORM_FIELDS_ORDER_INDEX_SQL,
  idx_applications_guild_applicant_form_active:
    APPLICATIONS_GUILD_APPLICANT_FORM_ACTIVE_INDEX_SQL,
  idx_applications_guild_state: APPLICATIONS_GUILD_STATE_INDEX_SQL,
  idx_applications_guild_form_state: APPLICATIONS_GUILD_FORM_STATE_INDEX_SQL,
  idx_applications_guild_applicant_created:
    APPLICATIONS_GUILD_APPLICANT_CREATED_INDEX_SQL,
  idx_applications_guild_review_message:
    APPLICATIONS_GUILD_REVIEW_MESSAGE_INDEX_SQL,
  idx_application_events_application: APPLICATION_EVENTS_APPLICATION_INDEX_SQL,
};

export const V6_TABLE_NAMES = [
  ...V5_TABLE_NAMES,
  "restricted_ping_roles",
  "restricted_ping_channels",
  "restricted_ping_user_cooldowns",
  "restricted_ping_events",
] as const;

export const V6_EXPLICIT_INDEX_NAMES = [
  ...V5_EXPLICIT_INDEX_NAMES,
  "idx_restricted_ping_roles_guild_enabled",
  "idx_restricted_ping_roles_reservation",
  "idx_restricted_ping_channels_guild_channel",
  "idx_restricted_ping_events_role_number",
  "idx_restricted_ping_events_success_number",
] as const;

const V6_TABLE_SQL: Record<(typeof V6_TABLE_NAMES)[number], string> = {
  ...V5_TABLE_SQL,
  restricted_ping_roles: RESTRICTED_PING_ROLES_TABLE_SQL,
  restricted_ping_channels: RESTRICTED_PING_CHANNELS_TABLE_SQL,
  restricted_ping_user_cooldowns: RESTRICTED_PING_USER_COOLDOWNS_TABLE_SQL,
  restricted_ping_events: RESTRICTED_PING_EVENTS_TABLE_SQL,
};

const V6_INDEX_SQL: Record<(typeof V6_EXPLICIT_INDEX_NAMES)[number], string> = {
  ...V5_INDEX_SQL,
  idx_restricted_ping_roles_guild_enabled:
    RESTRICTED_PING_ROLES_GUILD_ENABLED_INDEX_SQL,
  idx_restricted_ping_roles_reservation:
    RESTRICTED_PING_ROLES_RESERVATION_INDEX_SQL,
  idx_restricted_ping_channels_guild_channel:
    RESTRICTED_PING_CHANNELS_GUILD_CHANNEL_INDEX_SQL,
  idx_restricted_ping_events_role_number:
    RESTRICTED_PING_EVENTS_ROLE_NUMBER_INDEX_SQL,
  idx_restricted_ping_events_success_number:
    RESTRICTED_PING_EVENTS_SUCCESS_NUMBER_INDEX_SQL,
};

export const V7_TABLE_NAMES = [
  ...V6_TABLE_NAMES,
  "mudae_watch_deliveries",
] as const;

export const V7_EXPLICIT_INDEX_NAMES = [
  ...V6_EXPLICIT_INDEX_NAMES,
  "idx_mudae_watch_deliveries_guild_state_updated",
  "idx_mudae_watch_deliveries_reservation",
] as const;

const V7_TABLE_SQL: Record<(typeof V7_TABLE_NAMES)[number], string> = {
  ...V6_TABLE_SQL,
  mudae_watch_deliveries: MUDAE_WATCH_DELIVERIES_TABLE_SQL,
};

const V7_INDEX_SQL: Record<(typeof V7_EXPLICIT_INDEX_NAMES)[number], string> = {
  ...V6_INDEX_SQL,
  idx_mudae_watch_deliveries_guild_state_updated:
    MUDAE_WATCH_DELIVERIES_GUILD_STATE_UPDATED_INDEX_SQL,
  idx_mudae_watch_deliveries_reservation:
    MUDAE_WATCH_DELIVERIES_RESERVATION_INDEX_SQL,
};

export const V1_TABLE_NAMES = [
  "kv",
  "posts",
  "answers",
  "metrics",
  "anon_cooldowns",
] as const;

export const V2_TABLE_NAMES = [
  "schema_migrations",
  "guilds",
  "guild_settings",
  "kv",
  "posts",
  "answers",
  "metrics",
  "anon_cooldowns",
] as const;

const V2_EXPLICIT_INDEX_NAMES = [
  "idx_posts_guild_closed_posted_at",
  "idx_posts_guild_posted_at",
  "idx_answers_guild_question_created",
  "idx_answers_guild_message_id",
  "idx_answers_guild_created_at",
  "idx_guilds_enabled_left_at",
] as const;

const V1_EXPLICIT_INDEX_NAMES = [
  "idx_posts_closed_posted_at",
  "idx_answers_question_created",
  "idx_answers_message_id",
] as const;

// Frozen v2 definitions are used only to identify the supported migration
// source. They intentionally match the final v4 schema byte-for-byte after
// SQL normalization.
const V2_TABLE_SQL: Record<(typeof V2_TABLE_NAMES)[number], string> = {
  schema_migrations: `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  guilds: `CREATE TABLE guilds (
    guild_id TEXT NOT NULL PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    name TEXT,
    joined_at TEXT,
    left_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  guild_settings: `CREATE TABLE guild_settings (
    guild_id TEXT NOT NULL PRIMARY KEY,
    settings_version INTEGER NOT NULL,
    settings_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  kv: `CREATE TABLE kv (
    guild_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, key),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  posts: `CREATE TABLE posts (
    guild_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    thread_id TEXT,
    channel_id TEXT NOT NULL,
    category TEXT NOT NULL,
    question TEXT NOT NULL,
    posted_at TEXT NOT NULL,
    close_after_hours INTEGER NOT NULL DEFAULT 24,
    closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
    closed_at TEXT,
    close_reason TEXT,
    PRIMARY KEY (guild_id, message_id),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  answers: `CREATE TABLE answers (
    guild_id TEXT NOT NULL,
    question_message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    answer_message_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, question_message_id, user_id),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  metrics: `CREATE TABLE metrics (
    guild_id TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    metric_value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, metric_key),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
  anon_cooldowns: `CREATE TABLE anon_cooldowns (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_answer_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id),
    FOREIGN KEY (guild_id) REFERENCES guilds(guild_id) ON DELETE CASCADE
  )`,
};

const V2_INDEX_SQL: Record<(typeof V2_EXPLICIT_INDEX_NAMES)[number], string> = {
  idx_posts_guild_closed_posted_at:
    "CREATE INDEX idx_posts_guild_closed_posted_at ON posts (guild_id, closed, julianday(posted_at))",
  idx_posts_guild_posted_at:
    "CREATE INDEX idx_posts_guild_posted_at ON posts (guild_id, julianday(posted_at))",
  idx_answers_guild_question_created:
    "CREATE INDEX idx_answers_guild_question_created ON answers (guild_id, question_message_id, created_at)",
  idx_answers_guild_message_id:
    "CREATE INDEX idx_answers_guild_message_id ON answers (guild_id, answer_message_id)",
  idx_answers_guild_created_at:
    "CREATE INDEX idx_answers_guild_created_at ON answers (guild_id, julianday(created_at))",
  idx_guilds_enabled_left_at:
    "CREATE INDEX idx_guilds_enabled_left_at ON guilds (enabled, left_at)",
};

interface SchemaObjectRow {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

interface GuildDataRow {
  guild_id: string;
  enabled: number;
  joined_at: string | null;
  left_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SettingsDataRow {
  guild_id: string;
  settings_version: number;
  settings_json: string;
  updated_at: string;
}

interface MetricDataRow {
  guild_id: string;
  metric_key: string;
  metric_value: number;
  updated_at: string;
}

interface TicketConfigurationDataRow {
  guild_id: string;
  enabled: number;
  category_id: string;
  log_channel_id: string;
  support_role_id: string;
  created_at: string;
  updated_at: string;
}

interface PostedPanelDataRow {
  guild_id: string;
  panel_id: string;
  preset: string;
  channel_id: string;
  message_id: string;
  configuration_json: string;
  created_at: string;
  updated_at: string;
}

interface TicketDataRow {
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

interface TicketEventDataRow {
  guild_id: string;
  ticket_id: string;
  event_id: string;
  event_number: number;
  event_type: string;
  actor_id: string | null;
  details_json: string;
  created_at: string;
}

export function createV3Objects(db: Database.Database): void {
  for (const table of V3_TABLE_NAMES) {
    db.exec(V3_TABLE_SQL[table]);
  }
  for (const index of V3_EXPLICIT_INDEX_NAMES) {
    db.exec(V3_INDEX_SQL[index]);
  }
}

/** Adds only the operational objects introduced by schema v4. */
export function createV4OperationalObjects(db: Database.Database): void {
  for (const table of [
    "ticket_configurations",
    "posted_panels",
    "tickets",
    "ticket_events",
  ] as const) {
    db.exec(V4_TABLE_SQL[table]);
  }
  for (const index of V4_EXPLICIT_INDEX_NAMES) {
    if (!(V3_EXPLICIT_INDEX_NAMES as readonly string[]).includes(index)) {
      db.exec(V4_INDEX_SQL[index]);
    }
  }
}

export function createV4Objects(db: Database.Database): void {
  createV3Objects(db);
  createV4OperationalObjects(db);
}

/** Creates only the objects introduced by schema v5 on top of schema v3. */
export function createV5OperationalObjects(db: Database.Database): void {
  for (const table of V5_TABLE_NAMES) {
    if (!(V3_TABLE_NAMES as readonly string[]).includes(table)) {
      db.exec(V5_TABLE_SQL[table]);
    }
  }
  for (const index of V5_EXPLICIT_INDEX_NAMES) {
    if (!(V3_EXPLICIT_INDEX_NAMES as readonly string[]).includes(index)) {
      db.exec(V5_INDEX_SQL[index]);
    }
  }
}

export function createV5Objects(db: Database.Database): void {
  createV3Objects(db);
  createV5OperationalObjects(db);
}

/** Adds only the restricted-role-ping objects introduced by schema v6. */
export function createV6OperationalObjects(db: Database.Database): void {
  for (const table of V6_TABLE_NAMES) {
    if (!(V5_TABLE_NAMES as readonly string[]).includes(table)) {
      db.exec(V6_TABLE_SQL[table]);
    }
  }
  for (const index of V6_EXPLICIT_INDEX_NAMES) {
    if (!(V5_EXPLICIT_INDEX_NAMES as readonly string[]).includes(index)) {
      db.exec(V6_INDEX_SQL[index]);
    }
  }
}

export function createV6Objects(db: Database.Database): void {
  createV5Objects(db);
  createV6OperationalObjects(db);
}

/** Adds only the internal delivery-deduplication objects introduced by schema v7. */
export function createV7OperationalObjects(db: Database.Database): void {
  for (const table of V7_TABLE_NAMES) {
    if (!(V6_TABLE_NAMES as readonly string[]).includes(table)) {
      db.exec(V7_TABLE_SQL[table]);
    }
  }
  for (const index of V7_EXPLICIT_INDEX_NAMES) {
    if (!(V6_EXPLICIT_INDEX_NAMES as readonly string[]).includes(index)) {
      db.exec(V7_INDEX_SQL[index]);
    }
  }
}

export function createV7Objects(db: Database.Database): void {
  createV6Objects(db);
  createV7OperationalObjects(db);
}

export function recordV4SchemaVersion(
  db: Database.Database,
  appliedAt: string,
): void {
  db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(LEGACY_V4_SCHEMA_VERSION, appliedAt);
}

export function recordV5SchemaVersion(
  db: Database.Database,
  appliedAt: string,
): void {
  db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(LEGACY_V5_SCHEMA_VERSION, appliedAt);
}

export function recordV6SchemaVersion(
  db: Database.Database,
  appliedAt: string,
): void {
  db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(LEGACY_V6_SCHEMA_VERSION, appliedAt);
}

export function recordCurrentSchemaVersion(
  db: Database.Database,
  appliedAt: string,
): void {
  db.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(CURRENT_SCHEMA_VERSION, appliedAt);
}

export function initializeV3Schema(
  db: Database.Database,
  appliedAt: string,
): void {
  const initialize = db.transaction(() => {
    createV3Objects(db);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(LEGACY_V3_SCHEMA_VERSION, appliedAt);
    const issues = validateV3Schema(db);
    if (issues.length > 0) {
      throw new Error(`Failed to initialize schema: ${issues.join("; ")}`);
    }
  });
  initialize.immediate();
}

export function initializeV4Schema(
  db: Database.Database,
  appliedAt: string,
): void {
  const initialize = db.transaction(() => {
    createV4Objects(db);
    recordV4SchemaVersion(db, appliedAt);
    const issues = validateV4Schema(db);
    if (issues.length > 0) {
      throw new Error(`Failed to initialize schema: ${issues.join("; ")}`);
    }
  });
  initialize.immediate();
}

export function initializeV5Schema(
  db: Database.Database,
  appliedAt: string,
): void {
  const initialize = db.transaction(() => {
    createV5Objects(db);
    recordV5SchemaVersion(db, appliedAt);
    const issues = validateV5Schema(db);
    if (issues.length > 0) {
      throw new Error(`Failed to initialize schema: ${issues.join("; ")}`);
    }
  });
  initialize.immediate();
}

export function initializeV6Schema(
  db: Database.Database,
  appliedAt: string,
): void {
  const initialize = db.transaction(() => {
    createV6Objects(db);
    recordV6SchemaVersion(db, appliedAt);
    const issues = validateV6Schema(db);
    if (issues.length > 0) {
      throw new Error(`Failed to initialize schema: ${issues.join("; ")}`);
    }
  });
  initialize.immediate();
}

export function initializeV7Schema(
  db: Database.Database,
  appliedAt: string,
): void {
  const initialize = db.transaction(() => {
    createV7Objects(db);
    recordCurrentSchemaVersion(db, appliedAt);
    const issues = validateV7Schema(db);
    if (issues.length > 0) {
      throw new Error(`Failed to initialize schema: ${issues.join("; ")}`);
    }
  });
  initialize.immediate();
}

export function getUserTableNames(db: Database.Database): string[] {
  return getSchemaObjects(db)
    .filter((row) => row.type === "table")
    .map((row) => row.name)
    .sort();
}

export function detectDatabaseSchema(
  db: Database.Database,
): DatabaseSchemaKind {
  const objects = getSchemaObjects(db);
  if (objects.length === 0) {
    return "empty";
  }

  const tables = objects
    .filter((row) => row.type === "table")
    .map((row) => row.name)
    .sort();

  if (sameStrings(tables, [...V7_TABLE_NAMES].sort())) {
    return validateV7Schema(db).length === 0 ? "current-v7" : "unknown";
  }
  if (sameStrings(tables, [...V6_TABLE_NAMES].sort())) {
    return validateV6Schema(db).length === 0 ? "legacy-v6" : "unknown";
  }
  if (sameStrings(tables, [...V5_TABLE_NAMES].sort())) {
    return validateV5Schema(db).length === 0 ? "legacy-v5" : "unknown";
  }
  if (sameStrings(tables, [...V4_TABLE_NAMES].sort())) {
    return validateV4Schema(db).length === 0 ? "legacy-v4" : "unknown";
  }
  if (sameStrings(tables, [...V3_TABLE_NAMES].sort())) {
    return validateV3Schema(db).length === 0 ? "legacy-v3" : "unknown";
  }
  if (sameStrings(tables, [...V2_TABLE_NAMES].sort())) {
    return validateV2Schema(db).length === 0 ? "legacy-v2" : "unknown";
  }
  if (sameStrings(tables, [...V1_TABLE_NAMES].sort())) {
    return validateV1Schema(db).length === 0 ? "legacy-v1" : "unknown";
  }
  return "unknown";
}

export function validateV3Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V3_TABLE_NAMES],
    [...V3_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }

  validateSqlDefinitions(db, V3_TABLE_SQL, "table", issues);
  validateSqlDefinitions(db, V3_INDEX_SQL, "index", issues);
  validateColumnsAndKeys(
    db,
    {
      schema_migrations: ["version", "applied_at"],
      guilds: [
        "guild_id",
        "enabled",
        "name",
        "joined_at",
        "left_at",
        "created_at",
        "updated_at",
      ],
      guild_settings: [
        "guild_id",
        "settings_version",
        "settings_json",
        "updated_at",
      ],
      metrics: ["guild_id", "metric_key", "metric_value", "updated_at"],
    },
    {
      schema_migrations: ["version"],
      guilds: ["guild_id"],
      guild_settings: ["guild_id"],
      metrics: ["guild_id", "metric_key"],
    },
    issues,
  );
  validateGuildForeignKey(db, "guild_settings", issues);
  validateGuildForeignKey(db, "metrics", issues);

  const versions = db
    .prepare(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; applied_at: string }>;
  if (
    versions.length !== 1 ||
    versions[0]?.version !== LEGACY_V3_SCHEMA_VERSION ||
    !isValidTimestamp(versions[0]?.applied_at)
  ) {
    issues.push(
      `schema_migrations must contain exactly version ${LEGACY_V3_SCHEMA_VERSION}`,
    );
  }

  validateV3Data(db, issues);
  validateDatabaseHealth(db, issues);
  return issues;
}

export function validateV4Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V4_TABLE_NAMES],
    [...V4_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }

  validateSqlDefinitions(db, V4_TABLE_SQL, "table", issues);
  validateSqlDefinitions(db, V4_INDEX_SQL, "index", issues);
  validateColumnsAndKeys(
    db,
    {
      schema_migrations: ["version", "applied_at"],
      guilds: [
        "guild_id",
        "enabled",
        "name",
        "joined_at",
        "left_at",
        "created_at",
        "updated_at",
      ],
      guild_settings: [
        "guild_id",
        "settings_version",
        "settings_json",
        "updated_at",
      ],
      metrics: ["guild_id", "metric_key", "metric_value", "updated_at"],
      ticket_configurations: [
        "guild_id",
        "enabled",
        "category_id",
        "log_channel_id",
        "support_role_id",
        "created_at",
        "updated_at",
      ],
      posted_panels: [
        "guild_id",
        "panel_id",
        "preset",
        "channel_id",
        "message_id",
        "configuration_json",
        "created_at",
        "updated_at",
      ],
      tickets: [
        "guild_id",
        "ticket_id",
        "ticket_number",
        "opener_id",
        "channel_id",
        "control_message_id",
        "subject",
        "description",
        "state",
        "claimed_by",
        "claimed_at",
        "closed_by",
        "close_reason",
        "close_log_message_id",
        "close_logged_at",
        "failure_reason",
        "created_at",
        "updated_at",
        "closing_at",
        "closed_at",
      ],
      ticket_events: [
        "guild_id",
        "ticket_id",
        "event_id",
        "event_number",
        "event_type",
        "actor_id",
        "details_json",
        "created_at",
      ],
    },
    {
      schema_migrations: ["version"],
      guilds: ["guild_id"],
      guild_settings: ["guild_id"],
      metrics: ["guild_id", "metric_key"],
      ticket_configurations: ["guild_id"],
      posted_panels: ["guild_id", "panel_id"],
      tickets: ["guild_id", "ticket_id"],
      ticket_events: ["guild_id", "ticket_id", "event_id"],
    },
    issues,
  );
  for (const table of [
    "guild_settings",
    "metrics",
    "ticket_configurations",
    "posted_panels",
    "tickets",
  ]) {
    validateGuildForeignKey(db, table, issues);
  }
  validateTicketEventForeignKeys(db, issues);

  const versions = db
    .prepare(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; applied_at: string }>;
  const validVersionSequence =
    (versions.length === 1 &&
      versions[0]?.version === LEGACY_V4_SCHEMA_VERSION) ||
    (versions.length === 2 &&
      versions[0]?.version === LEGACY_V3_SCHEMA_VERSION &&
      versions[1]?.version === LEGACY_V4_SCHEMA_VERSION);
  if (
    !validVersionSequence ||
    versions.some((row) => !isValidTimestamp(row.applied_at))
  ) {
    issues.push(
      "schema_migrations must contain version 4, optionally following version 3",
    );
  }

  validateV3Data(db, issues);
  validateV4Data(db, issues);
  validateDatabaseHealth(db, issues);
  return issues;
}

export function validateV5Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V5_TABLE_NAMES],
    [...V5_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }

  validateSqlDefinitions(db, V5_TABLE_SQL, "table", issues);
  validateSqlDefinitions(db, V5_INDEX_SQL, "index", issues);

  const versions = db
    .prepare(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; applied_at: string }>;
  const versionNumbers = versions.map((row) => row.version);
  const validVersionSequence = [
    [LEGACY_V5_SCHEMA_VERSION],
    [LEGACY_V4_SCHEMA_VERSION, LEGACY_V5_SCHEMA_VERSION],
    [
      LEGACY_V3_SCHEMA_VERSION,
      LEGACY_V4_SCHEMA_VERSION,
      LEGACY_V5_SCHEMA_VERSION,
    ],
  ].some(
    (expected) =>
      expected.length === versionNumbers.length &&
      expected.every((version, index) => versionNumbers[index] === version),
  );
  if (
    !validVersionSequence ||
    versions.some((row) => !isValidTimestamp(row.applied_at))
  ) {
    issues.push(
      "schema_migrations must contain version 5, optionally following version 4 or versions 3 and 4",
    );
  }

  validateV3Data(db, issues);
  validateV5Data(db, issues);
  validateDatabaseHealth(db, issues);
  return issues;
}

export function validateV6Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V6_TABLE_NAMES],
    [...V6_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }

  validateSqlDefinitions(db, V6_TABLE_SQL, "table", issues);
  validateSqlDefinitions(db, V6_INDEX_SQL, "index", issues);

  const versions = db
    .prepare(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; applied_at: string }>;
  const versionNumbers = versions.map((row) => row.version);
  const validVersionSequence = [
    [LEGACY_V6_SCHEMA_VERSION],
    [LEGACY_V5_SCHEMA_VERSION, LEGACY_V6_SCHEMA_VERSION],
    [
      LEGACY_V4_SCHEMA_VERSION,
      LEGACY_V5_SCHEMA_VERSION,
      LEGACY_V6_SCHEMA_VERSION,
    ],
    [
      LEGACY_V3_SCHEMA_VERSION,
      LEGACY_V4_SCHEMA_VERSION,
      LEGACY_V5_SCHEMA_VERSION,
      LEGACY_V6_SCHEMA_VERSION,
    ],
  ].some(
    (expected) =>
      expected.length === versionNumbers.length &&
      expected.every((version, index) => versionNumbers[index] === version),
  );
  if (
    !validVersionSequence ||
    versions.some((row) => !isValidTimestamp(row.applied_at))
  ) {
    issues.push(
      "schema_migrations must contain version 6, optionally following version 5, versions 4 and 5, or versions 3 through 5",
    );
  }

  validateV3Data(db, issues);
  validateV5Data(db, issues);
  validateV6Data(db, issues);
  validateDatabaseHealth(db, issues);
  return issues;
}

export function validateV7Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V7_TABLE_NAMES],
    [...V7_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }

  validateSqlDefinitions(db, V7_TABLE_SQL, "table", issues);
  validateSqlDefinitions(db, V7_INDEX_SQL, "index", issues);

  const versions = db
    .prepare(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; applied_at: string }>;
  const versionNumbers = versions.map((row) => row.version);
  const validVersionSequence = [
    [CURRENT_SCHEMA_VERSION],
    [LEGACY_V6_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION],
    [
      LEGACY_V5_SCHEMA_VERSION,
      LEGACY_V6_SCHEMA_VERSION,
      CURRENT_SCHEMA_VERSION,
    ],
    [
      LEGACY_V4_SCHEMA_VERSION,
      LEGACY_V5_SCHEMA_VERSION,
      LEGACY_V6_SCHEMA_VERSION,
      CURRENT_SCHEMA_VERSION,
    ],
    [
      LEGACY_V3_SCHEMA_VERSION,
      LEGACY_V4_SCHEMA_VERSION,
      LEGACY_V5_SCHEMA_VERSION,
      LEGACY_V6_SCHEMA_VERSION,
      CURRENT_SCHEMA_VERSION,
    ],
  ].some(
    (expected) =>
      expected.length === versionNumbers.length &&
      expected.every((version, index) => versionNumbers[index] === version),
  );
  if (
    !validVersionSequence ||
    versions.some((row) => !isValidTimestamp(row.applied_at))
  ) {
    issues.push(
      "schema_migrations must contain version 7, optionally following version 6, versions 5 and 6, versions 4 through 6, or versions 3 through 6",
    );
  }

  validateV3Data(db, issues);
  validateV5Data(db, issues);
  validateV6Data(db, issues);
  validateV7Data(db, issues);
  validateDatabaseHealth(db, issues);
  return issues;
}

export function validateV2Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V2_TABLE_NAMES],
    [...V2_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }

  validateSqlDefinitions(db, V2_TABLE_SQL, "table", issues);
  validateSqlDefinitions(db, V2_INDEX_SQL, "index", issues);
  for (const table of [
    "guild_settings",
    "kv",
    "posts",
    "answers",
    "metrics",
    "anon_cooldowns",
  ]) {
    validateGuildForeignKey(db, table, issues);
  }

  const versions = db
    .prepare(
      "SELECT version, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as Array<{ version: number; applied_at: string }>;
  if (
    versions.length === 0 ||
    versions.at(-1)?.version !== LEGACY_V2_SCHEMA_VERSION ||
    versions.some(
      (row) =>
        !Number.isInteger(row.version) ||
        row.version < 1 ||
        row.version > LEGACY_V2_SCHEMA_VERSION ||
        !isValidTimestamp(row.applied_at),
    )
  ) {
    issues.push("schema_migrations must end at version 2");
  }
  validateDatabaseHealth(db, issues);
  return issues;
}

export function databaseIntegrityCheck(db: Database.Database): string {
  const rows = db.pragma("integrity_check") as Array<{
    integrity_check: string;
  }>;
  return rows.map((row) => String(row.integrity_check)).join("; ");
}

function validateV1Schema(db: Database.Database): string[] {
  const issues = validateExactObjects(
    db,
    [...V1_TABLE_NAMES],
    [...V1_EXPLICIT_INDEX_NAMES],
  );
  if (issues.length > 0) {
    return issues;
  }
  const expectedColumns: Record<string, string[]> = {
    kv: ["key", "value", "updated_at"],
    posts: [
      "message_id",
      "thread_id",
      "channel_id",
      "category",
      "question",
      "posted_at",
      "close_after_hours",
      "closed",
      "closed_at",
      "close_reason",
    ],
    answers: [
      "question_message_id",
      "user_id",
      "answer_message_id",
      "created_at",
    ],
    metrics: ["metric_key", "metric_value", "updated_at"],
    anon_cooldowns: ["user_id", "last_answer_at"],
  };
  for (const [table, columns] of Object.entries(expectedColumns)) {
    const actual = tableInfo(db, table).map((row) => row.name);
    if (!sameStrings(actual, columns)) {
      issues.push(`${table} does not match the final v4 v1 layout`);
    }
  }
  return issues;
}

function validateV3Data(db: Database.Database, issues: string[]): void {
  const guilds = db
    .prepare(
      "SELECT guild_id, enabled, joined_at, left_at, created_at, updated_at FROM guilds ORDER BY guild_id",
    )
    .all() as GuildDataRow[];
  const settingsRows = db
    .prepare(
      "SELECT guild_id, settings_version, settings_json, updated_at FROM guild_settings ORDER BY guild_id",
    )
    .all() as SettingsDataRow[];

  if (settingsRows.length !== guilds.length) {
    issues.push("every guild must have exactly one settings row");
  }
  const guildById = new Map(guilds.map((row) => [row.guild_id, row]));
  for (const guild of guilds) {
    if (!isDiscordSnowflake(guild.guild_id)) {
      issues.push(`guilds contains invalid guild ID ${guild.guild_id}`);
    }
    if (guild.enabled !== 0 && guild.enabled !== 1) {
      issues.push(`guild ${guild.guild_id} has invalid enabled state`);
    }
    if (guild.enabled === 1 && guild.left_at !== null) {
      issues.push(`guild ${guild.guild_id} is enabled after leaving`);
    }
    if (
      !isValidTimestamp(guild.created_at) ||
      !isValidTimestamp(guild.updated_at) ||
      (guild.joined_at !== null && !isValidTimestamp(guild.joined_at)) ||
      (guild.left_at !== null && !isValidTimestamp(guild.left_at))
    ) {
      issues.push(`guild ${guild.guild_id} has invalid timestamps`);
    }
  }

  for (const row of settingsRows) {
    const guild = guildById.get(row.guild_id);
    if (!guild) {
      issues.push(`settings row ${row.guild_id} has no guild`);
      continue;
    }
    if (row.settings_version !== GUILD_SETTINGS_VERSION) {
      issues.push(`guild ${row.guild_id} settings version is not 2`);
      continue;
    }
    try {
      const settings = parseGuildSettingsJson(row.settings_json);
      if (settings.enabled !== Boolean(guild.enabled)) {
        issues.push(`guild ${row.guild_id} enabled state is inconsistent`);
      }
    } catch (error) {
      issues.push(
        `guild ${row.guild_id} settings are invalid: ${errorMessage(error)}`,
      );
    }
    if (!isValidTimestamp(row.updated_at)) {
      issues.push(`guild ${row.guild_id} settings timestamp is invalid`);
    }
  }

  const metrics = db
    .prepare(
      "SELECT guild_id, metric_key, metric_value, updated_at FROM metrics ORDER BY guild_id, metric_key",
    )
    .all() as MetricDataRow[];
  for (const metric of metrics) {
    if (!guildById.has(metric.guild_id)) {
      issues.push(`metric ${metric.metric_key} has no guild`);
    }
    if (
      !isActiveMetricKey(metric.metric_key) ||
      !Number.isSafeInteger(metric.metric_value) ||
      metric.metric_value < 0
    ) {
      issues.push(
        `guild ${metric.guild_id} has invalid metric ${metric.metric_key}`,
      );
    }
    if (!isValidTimestamp(metric.updated_at)) {
      issues.push(`metric ${metric.metric_key} timestamp is invalid`);
    }
  }
}

function validateV4Data(db: Database.Database, issues: string[]): void {
  const guildIds = new Set(
    (
      db.prepare("SELECT guild_id FROM guilds").all() as Array<{
        guild_id: string;
      }>
    ).map((row) => row.guild_id),
  );

  const configurations = db
    .prepare("SELECT * FROM ticket_configurations ORDER BY guild_id")
    .all() as TicketConfigurationDataRow[];
  const configuredGuildIds = new Set(configurations.map((row) => row.guild_id));
  for (const row of configurations) {
    if (!guildIds.has(row.guild_id)) {
      issues.push(`ticket configuration ${row.guild_id} has no guild`);
    }
    if (row.enabled !== 0 && row.enabled !== 1) {
      issues.push(
        `ticket configuration ${row.guild_id} has invalid enabled state`,
      );
    }
    for (const id of [
      row.category_id,
      row.log_channel_id,
      row.support_role_id,
    ]) {
      if (!isDiscordSnowflake(id)) {
        issues.push(
          `ticket configuration ${row.guild_id} has an invalid Discord ID`,
        );
        break;
      }
    }
    if (
      !isValidTimestamp(row.created_at) ||
      !isValidTimestamp(row.updated_at)
    ) {
      issues.push(
        `ticket configuration ${row.guild_id} has invalid timestamps`,
      );
    }
  }

  const panels = db
    .prepare("SELECT * FROM posted_panels ORDER BY guild_id, panel_id")
    .all() as PostedPanelDataRow[];
  for (const row of panels) {
    if (!guildIds.has(row.guild_id)) {
      issues.push(`posted panel ${row.panel_id} has no guild`);
    }
    if (
      !isOpaqueId(row.panel_id) ||
      !(V4_PANEL_PRESETS as readonly string[]).includes(row.preset) ||
      !isDiscordSnowflake(row.channel_id) ||
      !isDiscordSnowflake(row.message_id)
    ) {
      issues.push(`posted panel ${row.panel_id} has invalid identifiers`);
    }
    if (
      !isValidJson(row.configuration_json) ||
      Buffer.byteLength(row.configuration_json, "utf8") > 16_000
    ) {
      issues.push(
        `posted panel ${row.panel_id} has invalid configuration JSON`,
      );
    }
    if (
      !isValidTimestamp(row.created_at) ||
      !isValidTimestamp(row.updated_at)
    ) {
      issues.push(`posted panel ${row.panel_id} has invalid timestamps`);
    }
  }

  const tickets = db
    .prepare("SELECT * FROM tickets ORDER BY guild_id, ticket_number")
    .all() as TicketDataRow[];
  for (const row of tickets) {
    if (!guildIds.has(row.guild_id)) {
      issues.push(`ticket ${row.ticket_id} has no guild`);
    }
    if (
      (row.state === "creating" ||
        row.state === "open" ||
        row.state === "closing") &&
      !configuredGuildIds.has(row.guild_id)
    ) {
      issues.push(`active ticket ${row.ticket_id} has no ticket configuration`);
    }
    if (
      !isOpaqueId(row.ticket_id) ||
      !Number.isInteger(row.ticket_number) ||
      row.ticket_number < 1 ||
      !isDiscordSnowflake(row.opener_id) ||
      (row.channel_id !== null && !isDiscordSnowflake(row.channel_id)) ||
      (row.control_message_id !== null &&
        !isDiscordSnowflake(row.control_message_id)) ||
      (row.claimed_by !== null && !isDiscordSnowflake(row.claimed_by)) ||
      (row.closed_by !== null && !isDiscordSnowflake(row.closed_by)) ||
      (row.close_log_message_id !== null &&
        !isDiscordSnowflake(row.close_log_message_id)) ||
      !(V4_TICKET_STATES as readonly string[]).includes(row.state)
    ) {
      issues.push(`ticket ${row.ticket_id} has invalid identifiers or state`);
    }
    if (
      !isValidTimestamp(row.created_at) ||
      !isValidTimestamp(row.updated_at) ||
      (row.claimed_at !== null && !isValidTimestamp(row.claimed_at)) ||
      (row.close_logged_at !== null &&
        !isValidTimestamp(row.close_logged_at)) ||
      (row.closing_at !== null && !isValidTimestamp(row.closing_at)) ||
      (row.closed_at !== null && !isValidTimestamp(row.closed_at))
    ) {
      issues.push(`ticket ${row.ticket_id} has invalid timestamps`);
    }
    if (
      typeof row.subject !== "string" ||
      typeof row.description !== "string" ||
      row.subject.length < 1 ||
      row.subject.length > 100 ||
      row.description.length < 1 ||
      row.description.length > 2000 ||
      (row.close_reason !== null &&
        (typeof row.close_reason !== "string" ||
          row.close_reason.length < 1 ||
          row.close_reason.length > 500)) ||
      (row.failure_reason !== null &&
        (typeof row.failure_reason !== "string" ||
          row.failure_reason.length < 1 ||
          row.failure_reason.length > 1000))
    ) {
      issues.push(`ticket ${row.ticket_id} has invalid text`);
    }
  }

  const events = db
    .prepare(
      "SELECT * FROM ticket_events ORDER BY guild_id, ticket_id, created_at, event_id",
    )
    .all() as TicketEventDataRow[];
  for (const row of events) {
    if (!guildIds.has(row.guild_id)) {
      issues.push(`ticket event ${row.event_id} has no guild`);
    }
    if (
      !isOpaqueId(row.ticket_id) ||
      !isOpaqueId(row.event_id) ||
      !Number.isInteger(row.event_number) ||
      row.event_number < 1 ||
      !(V4_TICKET_EVENT_TYPES as readonly string[]).includes(row.event_type) ||
      (row.actor_id !== null && !isDiscordSnowflake(row.actor_id))
    ) {
      issues.push(
        `ticket event ${row.event_id} has invalid identifiers or type`,
      );
    }
    if (
      !isValidJson(row.details_json) ||
      Buffer.byteLength(row.details_json, "utf8") > 4_000
    ) {
      issues.push(`ticket event ${row.event_id} has invalid details JSON`);
    }
    if (!isValidTimestamp(row.created_at)) {
      issues.push(`ticket event ${row.event_id} has an invalid timestamp`);
    }
  }
}

function validateV5Data(db: Database.Database, issues: string[]): void {
  const textColumns: ReadonlyArray<
    readonly [
      table: string,
      required: readonly string[],
      nullable: readonly string[],
    ]
  > = [
    [
      "delegated_capability_grants",
      [
        "guild_id",
        "principal_type",
        "principal_id",
        "capability",
        "granted_by",
        "created_at",
        "updated_at",
      ],
      [],
    ],
    [
      "ticket_departments",
      [
        "guild_id",
        "department_id",
        "slug",
        "display_name",
        "description",
        "created_at",
        "updated_at",
      ],
      [
        "emoji",
        "category_id",
        "log_channel_id",
        "support_role_id",
        "bindings_verified_at",
      ],
    ],
    [
      "ticket_department_fields",
      [
        "guild_id",
        "department_id",
        "field_id",
        "label",
        "field_type",
        "created_at",
        "updated_at",
      ],
      ["description", "placeholder"],
    ],
    [
      "posted_panels",
      [
        "guild_id",
        "panel_id",
        "preset",
        "channel_id",
        "message_id",
        "configuration_json",
        "created_at",
        "updated_at",
      ],
      [],
    ],
    [
      "tickets",
      [
        "guild_id",
        "ticket_id",
        "department_id",
        "opener_id",
        "subject",
        "description",
        "state",
        "created_at",
        "updated_at",
      ],
      [
        "channel_id",
        "control_message_id",
        "claimed_by",
        "claimed_at",
        "closed_by",
        "close_reason",
        "close_log_message_id",
        "close_logged_at",
        "failure_reason",
        "closing_at",
        "closed_at",
      ],
    ],
    [
      "ticket_form_responses",
      [
        "guild_id",
        "ticket_id",
        "response_id",
        "field_id",
        "field_label",
        "field_type",
        "response_text",
        "created_at",
      ],
      [],
    ],
    [
      "ticket_events",
      [
        "guild_id",
        "ticket_id",
        "event_id",
        "event_type",
        "details_json",
        "created_at",
      ],
      ["actor_id"],
    ],
    [
      "suggestion_configurations",
      [
        "guild_id",
        "suggestion_channel_id",
        "reviewer_role_id",
        "created_at",
        "updated_at",
      ],
      ["review_channel_id", "bindings_verified_at"],
    ],
    [
      "suggestions",
      [
        "guild_id",
        "suggestion_id",
        "author_id",
        "title",
        "details",
        "state",
        "delivery_state",
        "created_at",
        "updated_at",
      ],
      [
        "channel_id",
        "message_id",
        "thread_id",
        "reviewer_id",
        "review_reason",
        "reviewed_at",
        "withdrawn_at",
        "failure_reason",
      ],
    ],
    [
      "suggestion_votes",
      ["guild_id", "suggestion_id", "voter_id", "created_at", "updated_at"],
      [],
    ],
    [
      "suggestion_events",
      [
        "guild_id",
        "suggestion_id",
        "event_id",
        "event_type",
        "details_json",
        "created_at",
      ],
      ["actor_id"],
    ],
    [
      "application_forms",
      [
        "guild_id",
        "form_id",
        "slug",
        "display_name",
        "description",
        "reviewer_role_id",
        "review_channel_id",
        "created_at",
        "updated_at",
      ],
      ["bindings_verified_at"],
    ],
    [
      "application_form_fields",
      [
        "guild_id",
        "form_id",
        "field_id",
        "label",
        "field_type",
        "created_at",
        "updated_at",
      ],
      ["description", "placeholder"],
    ],
    [
      "applications",
      [
        "guild_id",
        "application_id",
        "form_id",
        "applicant_id",
        "state",
        "delivery_state",
        "created_at",
        "updated_at",
      ],
      [
        "review_channel_id",
        "review_message_id",
        "claimed_by",
        "claimed_at",
        "decision_by",
        "decision_reason",
        "decided_at",
        "withdrawn_at",
        "failure_reason",
      ],
    ],
    [
      "application_responses",
      [
        "guild_id",
        "application_id",
        "response_id",
        "field_id",
        "field_label",
        "field_type",
        "response_text",
        "created_at",
      ],
      [],
    ],
    [
      "application_events",
      [
        "guild_id",
        "application_id",
        "event_id",
        "event_type",
        "details_json",
        "created_at",
      ],
      ["actor_id"],
    ],
  ];
  for (const [table, required, nullable] of textColumns) {
    validateTextColumnTypes(db, table, required, nullable, issues);
  }

  const timestampColumns: ReadonlyArray<
    readonly [
      table: string,
      required: readonly string[],
      nullable: readonly string[],
    ]
  > = [
    ["delegated_capability_grants", ["created_at", "updated_at"], []],
    [
      "ticket_departments",
      ["created_at", "updated_at"],
      ["bindings_verified_at"],
    ],
    ["ticket_department_fields", ["created_at", "updated_at"], []],
    ["posted_panels", ["created_at", "updated_at"], []],
    [
      "tickets",
      ["created_at", "updated_at"],
      ["claimed_at", "close_logged_at", "closing_at", "closed_at"],
    ],
    ["ticket_form_responses", ["created_at"], []],
    ["ticket_events", ["created_at"], []],
    [
      "suggestion_configurations",
      ["created_at", "updated_at"],
      ["bindings_verified_at"],
    ],
    [
      "suggestions",
      ["created_at", "updated_at"],
      ["reviewed_at", "withdrawn_at"],
    ],
    ["suggestion_votes", ["created_at", "updated_at"], []],
    ["suggestion_events", ["created_at"], []],
    [
      "application_forms",
      ["created_at", "updated_at"],
      ["bindings_verified_at"],
    ],
    ["application_form_fields", ["created_at", "updated_at"], []],
    [
      "applications",
      ["created_at", "updated_at"],
      ["claimed_at", "decided_at", "withdrawn_at"],
    ],
    ["application_responses", ["created_at"], []],
    ["application_events", ["created_at"], []],
  ];
  for (const [table, required, nullable] of timestampColumns) {
    validateTimestampColumns(db, table, required, nullable, issues);
  }

  validateNoMatchingRows(
    db,
    `SELECT 1 FROM ticket_departments
     GROUP BY guild_id HAVING COUNT(*) > 10 LIMIT 1`,
    "a guild has more than 10 ticket departments",
    issues,
  );
  validateNoMatchingRows(
    db,
    `SELECT 1 FROM ticket_department_fields
     GROUP BY guild_id, department_id HAVING COUNT(*) > 5 LIMIT 1`,
    "a ticket department has more than 5 form fields",
    issues,
  );
  validateNoMatchingRows(
    db,
    `SELECT 1 FROM tickets
     WHERE state IN ('creating', 'open', 'closing')
     GROUP BY guild_id, opener_id HAVING COUNT(*) > 3 LIMIT 1`,
    "a guild member has more than 3 active tickets",
    issues,
  );
  validateNoMatchingRows(
    db,
    `SELECT 1 FROM application_forms
     GROUP BY guild_id HAVING COUNT(*) > 25 LIMIT 1`,
    "a guild has more than 25 application forms",
    issues,
  );
  validateNoMatchingRows(
    db,
    `SELECT 1 FROM application_form_fields
     GROUP BY guild_id, form_id HAVING COUNT(*) > 5 LIMIT 1`,
    "an application form has more than 5 fields",
    issues,
  );
  validateNoMatchingRows(
    db,
    `SELECT 1
     FROM application_forms AS forms
     LEFT JOIN application_form_fields AS fields
       ON fields.guild_id = forms.guild_id AND fields.form_id = forms.form_id
     WHERE forms.enabled = 1
     GROUP BY forms.guild_id, forms.form_id
     HAVING COUNT(fields.field_id) NOT BETWEEN 1 AND 5
     LIMIT 1`,
    "an enabled application form does not have 1-5 fields",
    issues,
  );

  for (const [table, column] of [
    ["posted_panels", "configuration_json"],
    ["ticket_events", "details_json"],
    ["suggestion_events", "details_json"],
    ["application_events", "details_json"],
  ] as const) {
    const maximum = table === "posted_panels" ? 16_000 : 4_000;
    validateNoMatchingRows(
      db,
      `SELECT 1 FROM ${quoteIdentifier(table)}
       WHERE json_valid(${quoteIdentifier(column)}) = 0
          OR length(CAST(${quoteIdentifier(column)} AS BLOB)) > ${maximum}
       LIMIT 1`,
      `${table} contains invalid or oversized JSON`,
      issues,
    );
  }
}

function validateV6Data(db: Database.Database, issues: string[]): void {
  const textColumns: ReadonlyArray<
    readonly [
      table: string,
      required: readonly string[],
      nullable: readonly string[],
    ]
  > = [
    [
      "restricted_ping_roles",
      [
        "guild_id",
        "role_id",
        "created_by",
        "updated_by",
        "created_at",
        "updated_at",
      ],
      [
        "bindings_verified_at",
        "last_role_success_at",
        "reservation_id",
        "reservation_user_id",
        "reservation_channel_id",
        "reservation_source",
        "reservation_expires_at",
      ],
    ],
    [
      "restricted_ping_channels",
      ["guild_id", "role_id", "channel_id", "created_by", "created_at"],
      [],
    ],
    [
      "restricted_ping_user_cooldowns",
      ["guild_id", "role_id", "user_id", "last_success_at", "updated_at"],
      [],
    ],
    [
      "restricted_ping_events",
      [
        "guild_id",
        "event_id",
        "event_type",
        "role_id",
        "source",
        "details_json",
        "created_at",
      ],
      ["actor_id", "channel_id", "user_id"],
    ],
  ];
  for (const [table, required, nullable] of textColumns) {
    validateTextColumnTypes(db, table, required, nullable, issues);
  }

  const timestampColumns: ReadonlyArray<
    readonly [
      table: string,
      required: readonly string[],
      nullable: readonly string[],
    ]
  > = [
    [
      "restricted_ping_roles",
      ["created_at", "updated_at"],
      [
        "bindings_verified_at",
        "last_role_success_at",
        "reservation_expires_at",
      ],
    ],
    ["restricted_ping_channels", ["created_at"], []],
    ["restricted_ping_user_cooldowns", ["last_success_at", "updated_at"], []],
    ["restricted_ping_events", ["created_at"], []],
  ];
  for (const [table, required, nullable] of timestampColumns) {
    validateTimestampColumns(db, table, required, nullable, issues);
  }

  validateNoMatchingRows(
    db,
    `SELECT 1 FROM restricted_ping_roles
     WHERE role_id = guild_id
        OR (last_role_success_at IS NULL) != (success_count = 0)
        OR (reservation_id IS NULL) != (reservation_user_id IS NULL)
        OR (reservation_id IS NULL) != (reservation_channel_id IS NULL)
        OR (reservation_id IS NULL) != (reservation_source IS NULL)
        OR (reservation_id IS NULL) != (reservation_expires_at IS NULL)
     LIMIT 1`,
    "restricted_ping_roles contains invalid success or reservation state",
    issues,
  );

  validateNoMatchingRows(
    db,
    `SELECT 1 FROM restricted_ping_roles
     WHERE length(role_id) NOT BETWEEN 17 AND 20
        OR role_id GLOB '*[^0-9]*'
        OR length(created_by) NOT BETWEEN 17 AND 20
        OR created_by GLOB '*[^0-9]*'
        OR length(updated_by) NOT BETWEEN 17 AND 20
        OR updated_by GLOB '*[^0-9]*'
        OR (reservation_user_id IS NOT NULL AND (
          length(reservation_user_id) NOT BETWEEN 17 AND 20
          OR reservation_user_id GLOB '*[^0-9]*'
        ))
        OR (reservation_channel_id IS NOT NULL AND (
          length(reservation_channel_id) NOT BETWEEN 17 AND 20
          OR reservation_channel_id GLOB '*[^0-9]*'
        ))
     LIMIT 1`,
    "restricted_ping_roles contains invalid Discord identifiers",
    issues,
  );

  validateNoMatchingRows(
    db,
    `SELECT 1 FROM restricted_ping_events
     WHERE event_type = 'ping_succeeded'
     GROUP BY guild_id HAVING COUNT(*) > 10000
     LIMIT 1`,
    "restricted_ping_events exceeds the per-guild successful event limit",
    issues,
  );

  validateNoMatchingRows(
    db,
    `SELECT 1 FROM restricted_ping_events
     WHERE json_valid(details_json) = 0
        OR length(CAST(details_json AS BLOB)) NOT BETWEEN 2 AND 4000
     LIMIT 1`,
    "restricted_ping_events contains invalid or oversized JSON",
    issues,
  );
}

function validateV7Data(db: Database.Database, issues: string[]): void {
  validateTextColumnTypes(
    db,
    "mudae_watch_deliveries",
    ["guild_id", "message_id", "delivery_state", "created_at", "updated_at"],
    ["reservation_id", "completed_at"],
    issues,
  );
  validateTimestampColumns(
    db,
    "mudae_watch_deliveries",
    ["created_at", "updated_at"],
    ["completed_at"],
    issues,
  );
  validateGuildForeignKey(db, "mudae_watch_deliveries", issues);

  validateNoMatchingRows(
    db,
    `SELECT 1 FROM mudae_watch_deliveries
     WHERE length(message_id) NOT BETWEEN 17 AND 20
        OR message_id GLOB '*[^0-9]*'
        OR delivery_state NOT IN ('reserved', 'delivered', 'failed')
        OR (reservation_id IS NOT NULL AND (
          length(reservation_id) NOT BETWEEN 8 AND 24
          OR reservation_id GLOB '*[^A-Za-z0-9_-]*'
        ))
        OR NOT (
          (
            delivery_state = 'reserved'
            AND reservation_id IS NOT NULL
            AND completed_at IS NULL
          ) OR (
            delivery_state IN ('delivered', 'failed')
            AND reservation_id IS NULL
            AND completed_at IS NOT NULL
          )
        )
     LIMIT 1`,
    "mudae_watch_deliveries contains invalid delivery state",
    issues,
  );

  validateNoMatchingRows(
    db,
    `SELECT 1 FROM mudae_watch_deliveries
     GROUP BY guild_id
     HAVING COUNT(*) > ${MAX_MUDAE_WATCH_DELIVERIES_PER_GUILD}
     LIMIT 1`,
    "mudae_watch_deliveries exceeds the per-guild record limit",
    issues,
  );
}

function validateTextColumnTypes(
  db: Database.Database,
  table: string,
  required: readonly string[],
  nullable: readonly string[],
  issues: string[],
): void {
  const predicates = [
    ...required.map((column) => `typeof(${quoteIdentifier(column)}) != 'text'`),
    ...nullable.map(
      (column) =>
        `(${quoteIdentifier(column)} IS NOT NULL AND typeof(${quoteIdentifier(column)}) != 'text')`,
    ),
  ];
  validateNoMatchingRows(
    db,
    `SELECT 1 FROM ${quoteIdentifier(table)} WHERE ${predicates.join(" OR ")} LIMIT 1`,
    `${table} contains non-text data in a text column`,
    issues,
  );
}

function validateTimestampColumns(
  db: Database.Database,
  table: string,
  required: readonly string[],
  nullable: readonly string[],
  issues: string[],
): void {
  const columns = [...required, ...nullable];
  if (columns.length === 0) return;
  const rows = db
    .prepare(
      `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    if (
      required.some((column) => !isValidTimestamp(row[column])) ||
      nullable.some(
        (column) => row[column] !== null && !isValidTimestamp(row[column]),
      )
    ) {
      issues.push(`${table} contains invalid timestamps`);
      return;
    }
  }
}

function validateNoMatchingRows(
  db: Database.Database,
  sql: string,
  issue: string,
  issues: string[],
): void {
  if (db.prepare(sql).get()) {
    issues.push(issue);
  }
}

function validateExactObjects(
  db: Database.Database,
  expectedTables: string[],
  expectedIndexes: string[],
): string[] {
  const objects = getSchemaObjects(db);
  const actualTables = objects
    .filter((row) => row.type === "table")
    .map((row) => row.name)
    .sort();
  const actualIndexes = objects
    .filter((row) => row.type === "index")
    .map((row) => row.name)
    .sort();
  const views = objects.filter((row) => row.type === "view");
  const triggers = objects.filter((row) => row.type === "trigger");

  const issues: string[] = [];
  if (!sameStrings(actualTables, [...expectedTables].sort())) {
    issues.push(
      `tables are (${actualTables.join(",")}), expected (${[...expectedTables].sort().join(",")})`,
    );
  }
  if (!sameStrings(actualIndexes, [...expectedIndexes].sort())) {
    issues.push(
      `explicit indexes are (${actualIndexes.join(",")}), expected (${[...expectedIndexes].sort().join(",")})`,
    );
  }
  if (views.length > 0) {
    issues.push(`unexpected views: ${views.map((row) => row.name).join(",")}`);
  }
  if (triggers.length > 0) {
    issues.push(
      `unexpected triggers: ${triggers.map((row) => row.name).join(",")}`,
    );
  }
  return issues;
}

function validateSqlDefinitions(
  db: Database.Database,
  expected: Record<string, string>,
  type: "table" | "index",
  issues: string[],
): void {
  for (const [name, sql] of Object.entries(expected)) {
    const row = db
      .prepare(
        "SELECT tbl_name, sql FROM sqlite_master WHERE type = ? AND name = ?",
      )
      .get(type, name) as { tbl_name: string; sql: string | null } | undefined;
    if (!row || normalizeSql(row.sql ?? "") !== normalizeSql(sql)) {
      issues.push(`${name} SQL does not match the required definition`);
    }
  }
}

function validateColumnsAndKeys(
  db: Database.Database,
  expectedColumns: Record<string, string[]>,
  expectedKeys: Record<string, string[]>,
  issues: string[],
): void {
  for (const [table, columns] of Object.entries(expectedColumns)) {
    const info = tableInfo(db, table);
    if (
      !sameStrings(
        info.map((row) => row.name),
        columns,
      )
    ) {
      issues.push(`${table} columns do not match the required order`);
    }
    const keys = info
      .filter((row) => row.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((row) => row.name);
    if (!sameStrings(keys, expectedKeys[table] ?? [])) {
      issues.push(`${table} primary key does not match the required key`);
    }
  }
}

function validateGuildForeignKey(
  db: Database.Database,
  table: string,
  issues: string[],
): void {
  const rows = db
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
    .all() as ForeignKeyRow[];
  if (
    rows.length !== 1 ||
    rows[0]?.table !== "guilds" ||
    rows[0]?.from !== "guild_id" ||
    rows[0]?.to !== "guild_id" ||
    rows[0]?.on_delete.toUpperCase() !== "CASCADE"
  ) {
    issues.push(`${table} must cascade from guilds(guild_id)`);
  }
}

function validateTicketEventForeignKeys(
  db: Database.Database,
  issues: string[],
): void {
  const rows = db
    .prepare("PRAGMA foreign_key_list(ticket_events)")
    .all() as ForeignKeyRow[];
  const hasGuild = rows.some(
    (row) =>
      row.table === "guilds" &&
      row.from === "guild_id" &&
      row.to === "guild_id" &&
      row.on_delete.toUpperCase() === "CASCADE",
  );
  const ticketColumns = rows
    .filter(
      (row) =>
        row.table === "tickets" && row.on_delete.toUpperCase() === "CASCADE",
    )
    .map((row) => `${row.from}:${row.to}`)
    .sort();
  if (
    rows.length !== 3 ||
    !hasGuild ||
    !sameStrings(ticketColumns, ["guild_id:guild_id", "ticket_id:ticket_id"])
  ) {
    issues.push(
      "ticket_events must cascade from its guild and composite ticket identity",
    );
  }
}

function validateDatabaseHealth(db: Database.Database, issues: string[]): void {
  const integrity = databaseIntegrityCheck(db);
  if (integrity.toLowerCase() !== "ok") {
    issues.push(`integrity_check failed: ${integrity}`);
  }
  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    issues.push("foreign_key_check reported violations");
  }
}

function getSchemaObjects(db: Database.Database): SchemaObjectRow[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('table', 'index', 'view', 'trigger')
       ORDER BY type, name`,
    )
    .all() as SchemaObjectRow[];
}

function tableInfo(db: Database.Database, table: string): TableInfoRow[] {
  return db
    .prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`)
    .all() as TableInfoRow[];
}

function normalizeSql(value: string): string {
  const literals: string[] = [];
  const protectedValue = value.replace(/'(?:''|[^'])*'/g, (literal) => {
    const index = literals.push(literal) - 1;
    return `\u0001${index}\u0002`;
  });
  const normalized = protectedValue
    .replaceAll(/["`\[\]]/g, "")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*([(),])\s*/g, "$1")
    .replace(/;$/, "")
    .trim()
    .toLowerCase();
  return normalized.replace(
    /\u0001(\d+)\u0002/g,
    (_match, rawIndex: string) => {
      const literal = literals[Number(rawIndex)];
      if (literal === undefined) {
        throw new Error("SQL literal normalization lost its placeholder");
      }
      return literal;
    },
  );
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 24 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isValidJson(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
